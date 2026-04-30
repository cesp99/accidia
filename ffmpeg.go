package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/ulikunitz/xz"
)

// FFmpegService locates, downloads, caches, and invokes a static ffmpeg binary.
// Its sole purpose is to let us decode long-tail audio formats (AAC, M4A,
// Opus, WMA, ALAC, MKA, etc.) without requiring the user to install
// anything themselves.
//
// Lookup order:
//  1. Cached path from a previous call
//  2. A binary we previously downloaded into the app cache directory
//  3. `ffmpeg` on $PATH (system install via homebrew / apt / scoop etc.)
//
// If none of those succeed, the frontend can call EnsureAvailable() to
// trigger an on-demand download with progress events.
type FFmpegService struct {
	mu      sync.Mutex
	binPath string // cached result of Locate()

	// cacheDir is where we extract downloaded binaries. Defaults to the
	// user's os-specific cache directory.
	cacheDir string

	// progress is the channel name for Wails events. Exposed so other
	// packages can reuse the same name for the frontend listener.
	progressEvent string
}

// NewFFmpegService returns a ready-to-use FFmpeg service. The actual
// cache directory is resolved lazily on first Download() so constructors
// stay side-effect-free.
func NewFFmpegService() *FFmpegService {
	return &FFmpegService{progressEvent: "ffmpeg:progress"}
}

// FFmpegStatus is what we tell the frontend on demand.
type FFmpegStatus struct {
	Available    bool   `json:"available"`
	Path         string `json:"path,omitempty"`
	Source       string `json:"source,omitempty"`  // "system" | "cache" | ""
	Platform     string `json:"platform,omitempty"` // e.g. "linux/amd64"
	DownloadURL  string `json:"downloadUrl,omitempty"`
	DownloadSize int64  `json:"downloadSize,omitempty"` // approximate, bytes
}

// Status returns the current availability of ffmpeg without downloading.
func (f *FFmpegService) Status() FFmpegStatus {
	s := FFmpegStatus{
		Platform: runtime.GOOS + "/" + runtime.GOARCH,
	}
	if path, source, err := f.locate(); err == nil {
		s.Available = true
		s.Path = path
		s.Source = source
	}
	if url, err := ffmpegDownloadURL(); err == nil {
		s.DownloadURL = url
		s.DownloadSize = 120 * 1024 * 1024 // rough upper bound; real size depends on platform
	}
	return s
}

// locate is the internal lookup. Returns (path, source, err).
func (f *FFmpegService) locate() (string, string, error) {
	f.mu.Lock()
	if f.binPath != "" {
		if _, err := os.Stat(f.binPath); err == nil {
			f.mu.Unlock()
			return f.binPath, "cache", nil
		}
		f.binPath = ""
	}
	f.mu.Unlock()

	// Cached download
	if local, err := f.cachedBin(); err == nil {
		if _, err := os.Stat(local); err == nil {
			f.rememberPath(local)
			return local, "cache", nil
		}
	}

	// System install
	if p, err := exec.LookPath("ffmpeg"); err == nil {
		f.rememberPath(p)
		return p, "system", nil
	}

	return "", "", errors.New("ffmpeg not found")
}

func (f *FFmpegService) rememberPath(path string) {
	f.mu.Lock()
	f.binPath = path
	f.mu.Unlock()
}

// Locate returns the currently usable ffmpeg path, or "" if none is
// available. It never downloads — use EnsureAvailable for that.
func (f *FFmpegService) Locate() (string, error) {
	p, _, err := f.locate()
	return p, err
}

// EnsureAvailable returns a working ffmpeg path, downloading a static
// build into the user's cache dir if neither the cached copy nor system
// ffmpeg can be found. Progress callbacks receive (bytesReceived, bytesTotal).
// For indeterminate downloads bytesTotal may be 0.
func (f *FFmpegService) EnsureAvailable(ctx context.Context, progress func(got, total int64, stage string)) (string, error) {
	if path, _, err := f.locate(); err == nil {
		return path, nil
	}
	if progress == nil {
		progress = func(int64, int64, string) {}
	}
	url, err := ffmpegDownloadURL()
	if err != nil {
		return "", err
	}
	progress(0, 0, "Fetching ffmpeg…")

	cacheDir, err := f.resolveCacheDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return "", err
	}

	tmp, err := os.CreateTemp(cacheDir, "ffmpeg-*.tmp")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	// Download to tmp file.
	if err := downloadWithProgress(ctx, url, tmp, progress); err != nil {
		tmp.Close()
		return "", err
	}
	tmp.Close()

	progress(0, 0, "Extracting…")
	binPath, err := f.extractArchive(tmpName, url, cacheDir)
	if err != nil {
		return "", err
	}
	// Mark executable on Unix-likes.
	if runtime.GOOS != "windows" {
		_ = os.Chmod(binPath, 0o755)
	}
	f.rememberPath(binPath)
	progress(0, 0, "Ready")
	return binPath, nil
}

// DecodeFile shells out to ffmpeg to decode `path` into a WAV byte slice.
// The output is a complete RIFF/WAVE file — the caller can pipe it into
// our existing WAV decoder or forward it to the frontend unchanged.
func (f *FFmpegService) DecodeFile(ctx context.Context, path string) ([]byte, error) {
	bin, err := f.Locate()
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, bin,
		"-hide_banner",
		"-v", "error",
		"-i", path,
		"-f", "wav",
		"-acodec", "pcm_s16le",
		"pipe:1",
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		return nil, fmt.Errorf("ffmpeg: %s", detail)
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Platform plumbing
// ---------------------------------------------------------------------------

// ffmpegDownloadURL returns the canonical URL we fetch a static ffmpeg from
// for the current platform. URLs stay stable across releases:
//
//   - Linux:  BtbN/FFmpeg-Builds "latest" tagged tarballs
//   - Windows: BtbN/FFmpeg-Builds "latest" tagged zip
//   - macOS:  evermeet.cx/ffmpeg (universal binary)
//
// These are all trusted, public, LGPL/GPL builds widely used by tools like
// yt-dlp, HandBrake, and Audacity's portable distributions.
func ffmpegDownloadURL() (string, error) {
	switch runtime.GOOS {
	case "linux":
		switch runtime.GOARCH {
		case "amd64":
			return "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz", nil
		case "arm64":
			return "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linuxarm64-gpl.tar.xz", nil
		}
	case "darwin":
		// Universal binary, serves both amd64 and arm64 Macs.
		return "https://evermeet.cx/ffmpeg/ffmpeg-7.1.zip", nil
	case "windows":
		if runtime.GOARCH == "amd64" {
			return "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip", nil
		}
	}
	return "", fmt.Errorf("no ffmpeg download URL for %s/%s", runtime.GOOS, runtime.GOARCH)
}

// resolveCacheDir returns the cache directory we use for downloaded ffmpeg.
// Prefers os.UserCacheDir() (XDG on Linux, Library/Caches on macOS,
// LocalAppData on Windows) and nests under Accidia/.
func (f *FFmpegService) resolveCacheDir() (string, error) {
	if f.cacheDir != "" {
		return f.cacheDir, nil
	}
	base, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	f.cacheDir = filepath.Join(base, "Accidia", "ffmpeg")
	return f.cacheDir, nil
}

// cachedBin returns the path where we expect to find a previously-downloaded
// ffmpeg binary (if one exists).
func (f *FFmpegService) cachedBin() (string, error) {
	dir, err := f.resolveCacheDir()
	if err != nil {
		return "", err
	}
	name := "ffmpeg"
	if runtime.GOOS == "windows" {
		name = "ffmpeg.exe"
	}
	return filepath.Join(dir, "bin", name), nil
}

// ---------------------------------------------------------------------------
// Download + extraction
// ---------------------------------------------------------------------------

// downloadWithProgress streams URL → dst, periodically invoking progress.
func downloadWithProgress(ctx context.Context, url string, dst io.Writer, progress func(got, total int64, stage string)) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Accidia/0.1 (+https://github.com/cesp99)")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("download: status %d", resp.StatusCode)
	}
	total := resp.ContentLength

	buf := make([]byte, 128*1024)
	var got int64
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return werr
			}
			got += int64(n)
			progress(got, total, "Downloading ffmpeg…")
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// extractArchive unpacks the downloaded archive and returns the path of the
// extracted ffmpeg binary. Archive format is inferred from the URL.
func (f *FFmpegService) extractArchive(archivePath, sourceURL, cacheDir string) (string, error) {
	binDir := filepath.Join(cacheDir, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return "", err
	}
	targetName := "ffmpeg"
	if runtime.GOOS == "windows" {
		targetName = "ffmpeg.exe"
	}
	target := filepath.Join(binDir, targetName)

	switch {
	case strings.HasSuffix(sourceURL, ".tar.xz"):
		return target, extractTarXZ(archivePath, target)
	case strings.HasSuffix(sourceURL, ".zip"):
		return target, extractZip(archivePath, target, targetName)
	default:
		return "", fmt.Errorf("unsupported archive format: %s", sourceURL)
	}
}

// extractTarXZ pulls the first file named `ffmpeg` (matching the exact
// basename) out of a .tar.xz archive and writes it to dst.
func extractTarXZ(src, dst string) error {
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer f.Close()
	xr, err := xz.NewReader(f)
	if err != nil {
		return fmt.Errorf("xz: %w", err)
	}
	tr := tar.NewReader(xr)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("tar: %w", err)
		}
		if h.Typeflag != tar.TypeReg {
			continue
		}
		if filepath.Base(h.Name) != "ffmpeg" {
			continue
		}
		out, err := os.Create(dst)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, tr); err != nil {
			out.Close()
			return err
		}
		return out.Close()
	}
	return errors.New("ffmpeg binary not found inside archive")
}

// extractZip pulls the first file whose basename matches `target` out of a
// .zip archive and writes it to dst.
func extractZip(src, dst, target string) error {
	r, err := zip.OpenReader(src)
	if err != nil {
		return err
	}
	defer r.Close()
	for _, f := range r.File {
		base := filepath.Base(f.Name)
		if base != target {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.Create(dst)
		if err != nil {
			rc.Close()
			return err
		}
		if _, err := io.Copy(out, rc); err != nil {
			rc.Close()
			out.Close()
			return err
		}
		rc.Close()
		return out.Close()
	}
	return fmt.Errorf("%s not found inside archive", target)
}

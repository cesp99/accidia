// Package library scans the user's music folder, extracts tags and cover
// art, and serves decoded audio to the frontend via the MediaStore.
package library

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dhowden/tag"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/cesp99/infinite-jukebox/internal/audio"
	"github.com/cesp99/infinite-jukebox/internal/ffmpeg"
	"github.com/cesp99/infinite-jukebox/internal/media"
	"github.com/cesp99/infinite-jukebox/internal/store"
)

// Re-export store types so callers importing `library` don't have to
// also import `store` just to handle its output types.
type (
	Track             = store.Track
	LibraryScanResult = store.LibraryScanResult
)

// audioExts lists the file extensions we treat as music. Lower-case.
// The pure-Go decoders handle mp3/wav/flac/ogg; everything else is
// dispatched to the FFmpeg sidecar.
var audioExts = map[string]struct{}{
	".mp3":  {},
	".m4a":  {},
	".m4b":  {},
	".aac":  {},
	".flac": {},
	".ogg":  {},
	".oga":  {},
	".opus": {},
	".wav":  {},
	".wave": {},
	".wma":  {},
	".alac": {},
	".aif":  {},
	".aiff": {},
	".ac3":  {},
	".mka":  {},
	".webm": {},
	".mp4":  {},
	".caf":  {},
	".ape":  {},
	".mpc":  {},
	".tta":  {},
}

// TrackPayload bundles the raw audio bytes (base64) with the resolved
// title for the frontend's Web Audio decoder. Rarely used — prefer
// DecodeTrack which returns int16 PCM over HTTP instead.
type TrackPayload struct {
	Path     string `json:"path"`
	Title    string `json:"title"`
	Artist   string `json:"artist"`
	Album    string `json:"album"`
	MimeType string `json:"mimeType"`
	DataB64  string `json:"dataB64"`
}

// DecodedAudio describes the result of decoding an audio file into PCM.
//
// The actual PCM bytes are served over HTTP via the MediaStore — embedding
// tens of megabytes in this struct would choke the JSON IPC bridge, and
// WebKit2GTK's `decodeAudioData` is flaky even on perfectly valid WAVs.
// The frontend fetches `MediaURL`, wraps the bytes in an `Int16Array`, and
// builds an `AudioBuffer` manually via `createBuffer` + `copyToChannel`,
// which sidesteps the platform's audio-decoder entirely.
type DecodedAudio struct {
	Path       string  `json:"path"`
	Title      string  `json:"title"`
	Artist     string  `json:"artist"`
	Album      string  `json:"album"`
	Duration   float64 `json:"duration"`
	SampleRate int     `json:"sampleRate"`
	Channels   int     `json:"channels"`
	// Frames is the number of audio frames per channel. `len(pcm) == Frames * Channels`.
	Frames int `json:"frames"`
	// MimeType of the body served at MediaURL.
	MimeType string `json:"mimeType"`
	// MediaURL points at interleaved little-endian int16 PCM bytes served
	// by MediaStore. Example: "/media/a1b2c3…". Lifetime is bounded by the
	// MediaStore LRU — the frontend should fetch promptly.
	MediaURL string `json:"mediaUrl"`
}

// Library is the long-lived service that scans, caches, and serves audio
// files from disk. It's safe for concurrent use.
type Library struct {
	store  *store.Store
	ffmpeg *ffmpeg.Service
	media  *media.Store

	mu  sync.RWMutex
	ctx context.Context
}

// New builds a Library backed by the given subsystems.
func New(st *store.Store, ff *ffmpeg.Service, md *media.Store) *Library {
	return &Library{store: st, ffmpeg: ff, media: md}
}

// AttachContext stores the Wails context so we can emit progress events.
func (l *Library) AttachContext(ctx context.Context) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.ctx = ctx
}

// Cached returns the most recent scan result we have on disk, or an empty
// result if there is no cache yet. Errors only surface for genuine I/O
// problems — a missing cache is not an error.
func (l *Library) Cached() (LibraryScanResult, error) {
	if cached, ok := l.store.Library(); ok {
		return cached, nil
	}
	return LibraryScanResult{Tracks: []Track{}}, nil
}

// Scan walks `root` recursively, extracts metadata for each audio file,
// persists the result, and returns it. Progress events are emitted on
// the `library:progress` channel so the UI can show a scan indicator.
func (l *Library) Scan(root string) (LibraryScanResult, error) {
	if root == "" {
		return LibraryScanResult{}, errors.New("library scan: empty path")
	}
	info, err := os.Stat(root)
	if err != nil {
		return LibraryScanResult{}, fmt.Errorf("stat root: %w", err)
	}
	if !info.IsDir() {
		return LibraryScanResult{}, fmt.Errorf("not a directory: %s", root)
	}

	tracks := make([]Track, 0, 256)
	totalFiles := 0
	startedAt := time.Now()

	emit := func(label string, scanned, total int) {
		if l.ctx == nil {
			return
		}
		wruntime.EventsEmit(l.ctx, "library:progress", map[string]any{
			"label":   label,
			"scanned": scanned,
			"total":   total,
		})
	}
	emit("Walking folder...", 0, 0)

	// First pass: collect the candidate file paths so we can show a
	// determinate progress bar in the UI.
	var candidates []string
	walkErr := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip unreadable entries silently
		}
		if info.IsDir() {
			// Skip common noise dirs without descending.
			if strings.HasPrefix(info.Name(), ".") || info.Name() == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		ext := strings.ToLower(filepath.Ext(path))
		if _, ok := audioExts[ext]; !ok {
			return nil
		}
		candidates = append(candidates, path)
		return nil
	})
	if walkErr != nil {
		return LibraryScanResult{}, fmt.Errorf("walk: %w", walkErr)
	}
	totalFiles = len(candidates)
	emit("Reading tags...", 0, totalFiles)

	// Second pass: parse tags. We don't keep the file open across calls —
	// memory pressure is more important than startup speed here.
	for i, path := range candidates {
		track, err := readTrack(path)
		if err != nil {
			// Don't fail the whole scan on one bad file.
			if l.ctx != nil {
				wruntime.LogWarningf(l.ctx, "skip %q: %v", path, err)
			}
			continue
		}
		tracks = append(tracks, track)
		if i%25 == 0 || i == len(candidates)-1 {
			emit("Reading tags...", i+1, totalFiles)
		}
	}

	// Sort: artist, album, disc, track, title.
	sort.SliceStable(tracks, func(i, j int) bool {
		if tracks[i].AlbumArtist != tracks[j].AlbumArtist {
			return tracks[i].AlbumArtist < tracks[j].AlbumArtist
		}
		if tracks[i].Artist != tracks[j].Artist {
			return tracks[i].Artist < tracks[j].Artist
		}
		if tracks[i].Album != tracks[j].Album {
			return tracks[i].Album < tracks[j].Album
		}
		if tracks[i].DiscNumber != tracks[j].DiscNumber {
			return tracks[i].DiscNumber < tracks[j].DiscNumber
		}
		if tracks[i].TrackNumber != tracks[j].TrackNumber {
			return tracks[i].TrackNumber < tracks[j].TrackNumber
		}
		return tracks[i].Title < tracks[j].Title
	})

	result := LibraryScanResult{
		Root:       root,
		Tracks:     tracks,
		ScannedAt:  time.Now().Unix(),
		TotalFiles: totalFiles,
	}
	if err := l.store.SaveLibrary(result); err != nil && l.ctx != nil {
		wruntime.LogErrorf(l.ctx, "save library cache: %v", err)
	}
	if l.ctx != nil {
		wruntime.LogInfof(l.ctx, "Scanned %d tracks in %s", len(tracks), time.Since(startedAt))
	}
	emit("Done", len(tracks), totalFiles)
	return result, nil
}

// readTrack opens the file just long enough to extract its tags + size.
func readTrack(path string) (Track, error) {
	info, err := os.Stat(path)
	if err != nil {
		return Track{}, err
	}
	f, err := os.Open(path)
	if err != nil {
		return Track{}, err
	}
	defer f.Close()

	t := Track{
		Path:    path,
		Size:    info.Size(),
		ModTime: info.ModTime().Unix(),
		Title:   strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)),
	}

	meta, err := tag.ReadFrom(f)
	if err != nil {
		// File without recognised tags — keep the filename-based fallback.
		return t, nil
	}
	t.Format = string(meta.Format())
	if v := meta.Title(); v != "" {
		t.Title = v
	}
	t.Artist = meta.Artist()
	t.Album = meta.Album()
	t.AlbumArtist = meta.AlbumArtist()
	t.Genre = meta.Genre()
	t.Year = meta.Year()
	if track, _ := meta.Track(); track > 0 {
		t.TrackNumber = track
	}
	if disc, _ := meta.Disc(); disc > 0 {
		t.DiscNumber = disc
	}
	if pic := meta.Picture(); pic != nil && len(pic.Data) > 0 {
		t.HasCoverArt = true
	}
	return t, nil
}

// LoadTrack returns the file's bytes wrapped as a base64 payload. The
// frontend hands this off to AudioContext.decodeAudioData for playback.
// We deliberately load fully into memory: the audio engine needs the
// whole buffer anyway, and this keeps the IPC simple.
//
// Note: This path is kept for uncompressed formats where the browser's
// decoder is guaranteed to succeed. For everything else the frontend
// should call DecodeTrack which shells out to our Go-side decoder and
// returns a universal WAV.
func (l *Library) LoadTrack(path string) (TrackPayload, error) {
	if path == "" {
		return TrackPayload{}, errors.New("empty path")
	}
	f, err := os.Open(path)
	if err != nil {
		return TrackPayload{}, fmt.Errorf("open: %w", err)
	}
	defer f.Close()

	// Buffer the file into memory.
	buf := bytes.Buffer{}
	if _, err := io.Copy(&buf, f); err != nil {
		return TrackPayload{}, fmt.Errorf("read: %w", err)
	}
	data := buf.Bytes()

	// Re-read tags from a re-opened file so we can ship title/artist back.
	mf, err := os.Open(path)
	if err != nil {
		return TrackPayload{}, fmt.Errorf("reopen: %w", err)
	}
	defer mf.Close()

	payload := TrackPayload{
		Path:     path,
		MimeType: mimeForExt(filepath.Ext(path)),
		Title:    strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)),
		DataB64:  base64.StdEncoding.EncodeToString(data),
	}
	if meta, err := tag.ReadFrom(mf); err == nil {
		if v := meta.Title(); v != "" {
			payload.Title = v
		}
		payload.Artist = meta.Artist()
		payload.Album = meta.Album()
	}
	return payload, nil
}

// DecodeTrack reads an audio file from disk, decodes it to 16-bit PCM,
// registers the interleaved PCM bytes in the MediaStore, and returns a
// URL + metadata the frontend can use to build an AudioBuffer directly.
//
// For MP3, FLAC, OGG Vorbis and WAV we decode natively in Go. For every
// other format (AAC, M4A, Opus, WMA, ALAC, AIFF, AC-3, MKA, etc.) we
// dispatch to the FFmpeg sidecar.
//
// IMPORTANT: we publish raw int16 PCM bytes, NOT a WAV container. The
// frontend wraps them in an `Int16Array`, normalises to float, and calls
// `createBuffer + copyToChannel` — skipping `decodeAudioData` entirely.
// This is necessary because WebKit2GTK's `decodeAudioData` is flaky even
// on well-formed WAV files, and the manual path is both more reliable
// and cheaper (no re-parsing of a container we already built).
//
// If ffmpeg is needed but not installed, this returns an error whose
// message starts with "ffmpeg-required:" so the frontend can offer to
// install it with a clear UI prompt instead of a raw error.
func (l *Library) DecodeTrack(path string) (DecodedAudio, error) {
	if path == "" {
		return DecodedAudio{}, errors.New("empty path")
	}

	ctx := l.contextOrBackground()
	logf := func(format string, args ...any) {
		if l.ctx != nil {
			wruntime.LogInfof(l.ctx, "[decode] "+format, args...)
		}
	}
	warnf := func(format string, args ...any) {
		if l.ctx != nil {
			wruntime.LogWarningf(l.ctx, "[decode] "+format, args...)
		}
	}

	start := time.Now()
	ext := strings.ToLower(filepath.Ext(path))
	logf("start path=%q ext=%s", path, ext)

	var (
		sr      int
		ch      int
		samples []int16
	)

	sr, ch, samples, err := audio.DecodeTrack(path)
	switch {
	case err == nil:
		// Native Go path (MP3/FLAC/OGG/WAV).
		logf("native decode ok: sr=%d ch=%d samples=%d", sr, ch, len(samples))

	case errors.Is(err, audio.ErrNeedsFFmpeg):
		if l.ffmpeg == nil {
			return DecodedAudio{}, fmt.Errorf("ffmpeg-required: no ffmpeg service configured")
		}
		bin, lerr := l.ffmpeg.Locate()
		if lerr != nil {
			return DecodedAudio{}, fmt.Errorf("ffmpeg-required: %s is not a natively-decoded format (MP3/FLAC/OGG/WAV). Install ffmpeg to play it", ext)
		}
		logf("dispatching to ffmpeg (bin=%s)", bin)
		wavBytes, derr := l.ffmpeg.DecodeFile(ctx, path)
		if derr != nil {
			warnf("ffmpeg decode failed: %v", derr)
			return DecodedAudio{}, fmt.Errorf("ffmpeg decode failed: %w", derr)
		}
		logf("ffmpeg produced %d WAV bytes", len(wavBytes))
		sr2, ch2, pcm, werr := audio.DecodeWAVBytes(wavBytes)
		if werr != nil {
			warnf("parsing ffmpeg WAV failed: %v", werr)
			return DecodedAudio{}, fmt.Errorf("parse ffmpeg output: %w", werr)
		}
		sr, ch, samples = sr2, ch2, pcm
		logf("ffmpeg WAV parsed: sr=%d ch=%d samples=%d", sr, ch, len(samples))

	default:
		warnf("native decoder error: %v", err)
		return DecodedAudio{}, err
	}

	if sr <= 0 || ch <= 0 || len(samples) == 0 {
		return DecodedAudio{}, fmt.Errorf("decoder produced empty output (sr=%d ch=%d samples=%d)", sr, ch, len(samples))
	}
	frames := len(samples) / ch
	duration := float64(frames) / float64(sr)

	// Serialise to little-endian bytes and push to the media store.
	pcmBytes := audio.PCMToLittleEndianBytes(samples)
	mediaURL, err := l.media.Put("application/octet-stream", pcmBytes)
	if err != nil {
		return DecodedAudio{}, fmt.Errorf("media store: %w", err)
	}

	out := DecodedAudio{
		Path:       path,
		Title:      strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)),
		Duration:   duration,
		SampleRate: sr,
		Channels:   ch,
		Frames:     frames,
		MimeType:   "application/octet-stream",
		MediaURL:   mediaURL,
	}
	// Re-read tags so we can surface title/artist/album alongside the PCM.
	if mf, err := os.Open(path); err == nil {
		defer mf.Close()
		if meta, err := tag.ReadFrom(mf); err == nil {
			if v := meta.Title(); v != "" {
				out.Title = v
			}
			out.Artist = meta.Artist()
			out.Album = meta.Album()
		}
	}
	logf("done path=%q duration=%.2fs frames=%d pcm=%d bytes url=%s took=%s",
		path, duration, frames, len(pcmBytes), mediaURL, time.Since(start))
	return out, nil
}

// contextOrBackground returns the attached Wails context, falling back to
// context.Background() if Attach hasn't run yet (unit tests etc.).
func (l *Library) contextOrBackground() context.Context {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if l.ctx != nil {
		return l.ctx
	}
	return context.Background()
}

// LoadCoverArt returns the embedded picture as a `data:image/...;base64,...`
// URL. Returns an empty string if no picture is present.
func (l *Library) LoadCoverArt(path string) (string, error) {
	if path == "" {
		return "", nil
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	meta, err := tag.ReadFrom(f)
	if err != nil {
		return "", nil
	}
	pic := meta.Picture()
	if pic == nil || len(pic.Data) == 0 {
		return "", nil
	}
	mime := pic.MIMEType
	if mime == "" {
		mime = "image/jpeg"
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(pic.Data), nil
}

// mimeForExt returns a reasonable Content-Type for an audio file extension
// so the frontend can hint the AudioContext about format detection.
func mimeForExt(ext string) string {
	switch strings.ToLower(ext) {
	case ".mp3":
		return "audio/mpeg"
	case ".m4a", ".aac":
		return "audio/mp4"
	case ".flac":
		return "audio/flac"
	case ".ogg", ".oga", ".opus":
		return "audio/ogg"
	case ".wav", ".wave":
		return "audio/wav"
	}
	return "application/octet-stream"
}

package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/ulikunitz/xz"
)

func TestFFmpegDownloadURL(t *testing.T) {
	url, err := ffmpegDownloadURL()
	if err != nil {
		t.Skipf("no URL for %s/%s — that's fine, skip", runtime.GOOS, runtime.GOARCH)
	}
	if url == "" {
		t.Error("expected non-empty URL")
	}
}

func TestFFmpegService_StatusWhenMissing(t *testing.T) {
	// Point the cache at an empty tmp dir so we're guaranteed nothing is
	// found there, even if the host has ffmpeg installed elsewhere.
	s := NewFFmpegService()
	s.cacheDir = t.TempDir()
	status := s.Status()
	// Status.Available depends on whether system ffmpeg is installed.
	// We don't assert on that — just make sure the struct is populated.
	if status.Platform == "" {
		t.Error("platform should always be filled")
	}
}

func TestExtractTarXZ_HappyPath(t *testing.T) {
	dir := t.TempDir()
	// Build a synthetic tar.xz containing a file called "ffmpeg" with a
	// known payload, then extract it.
	archive := filepath.Join(dir, "ffmpeg.tar.xz")
	payload := []byte("#!/bin/sh\nexit 0\n")
	if err := buildTarXZ(archive, map[string][]byte{
		"ffmpeg-build/bin/ffmpeg": payload,
		"ffmpeg-build/bin/ffprobe": []byte("ffprobe body"),
	}); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "ffmpeg")
	if err := extractTarXZ(archive, out); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("extracted contents don't match")
	}
}

func TestExtractZip_HappyPath(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "ffmpeg.zip")
	payload := []byte("fake ffmpeg binary")
	if err := buildZip(archive, map[string][]byte{
		"ffmpeg-release/bin/ffmpeg.exe": payload,
	}); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "ffmpeg.exe")
	if err := extractZip(archive, out, "ffmpeg.exe"); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("extracted contents don't match")
	}
}

// -------- helpers --------

func buildTarXZ(path string, files map[string][]byte) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	xw, err := xz.NewWriter(f)
	if err != nil {
		return err
	}
	defer xw.Close()
	tw := tar.NewWriter(xw)
	defer tw.Close()
	for name, body := range files {
		if err := tw.WriteHeader(&tar.Header{
			Name:     name,
			Mode:     0o755,
			Size:     int64(len(body)),
			Typeflag: tar.TypeReg,
		}); err != nil {
			return err
		}
		if _, err := tw.Write(body); err != nil {
			return err
		}
	}
	return nil
}

func buildZip(path string, files map[string][]byte) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	zw := zip.NewWriter(f)
	defer zw.Close()
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			return err
		}
		if _, err := w.Write(body); err != nil {
			return err
		}
	}
	return nil
}

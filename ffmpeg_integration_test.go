//go:build integration

package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestFFmpegService_DecodeM4A is an integration test that relies on a
// system ffmpeg binary being available (run under `-tags integration`).
// It runs automatically in our dev environment where ffmpeg is on PATH.
func TestFFmpegService_DecodeM4A(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("skipping on Windows: system ffmpeg not guaranteed in CI")
	}
	// The test fixture is produced at /tmp/test-tone.m4a by the dev bootstrap:
	//   ffmpeg -f lavfi -i "sine=frequency=440:duration=1" \
	//          -f lavfi -i "sine=frequency=880:duration=1" \
	//          -filter_complex amerge=inputs=2 -c:a aac -y /tmp/test-tone.m4a
	fixture := filepath.Join(os.TempDir(), "test-tone.m4a")
	if _, err := os.Stat(fixture); err != nil {
		t.Skipf("fixture %s not present — generate it first", fixture)
	}
	svc := NewFFmpegService()
	if _, err := svc.Locate(); err != nil {
		t.Skipf("ffmpeg not on PATH: %v", err)
	}
	wav, err := svc.DecodeFile(context.Background(), fixture)
	if err != nil {
		t.Fatalf("DecodeFile: %v", err)
	}
	// Sanity-check: ffmpeg's stdout should be a valid WAV.
	if len(wav) < 44 || string(wav[0:4]) != "RIFF" || string(wav[8:12]) != "WAVE" {
		t.Fatal("expected a RIFF/WAVE payload from ffmpeg")
	}
	sr, ch, pcm, err := decodeWAVBytes(wav)
	if err != nil {
		t.Fatalf("decodeWAVBytes: %v", err)
	}
	if sr == 0 || ch == 0 || len(pcm) == 0 {
		t.Fatalf("empty decode: sr=%d ch=%d pcm=%d", sr, ch, len(pcm))
	}
	t.Logf("decoded m4a → sr=%d ch=%d samples=%d", sr, ch, len(pcm))
}

//go:build integration

package main

import (
	"os"
	"os/exec"
	"testing"
)

// TestWriteGoWAVToDisk saves a Go-produced WAV to /tmp so we can probe it
// with ffmpeg / xxd and compare against a known-good WAV. Useful when
// WebKit's decodeAudioData complains about something we think is valid.
func TestWriteGoWAVToDisk(t *testing.T) {
	mp3 := "/tmp/test-440.mp3"
	if _, err := os.Stat(mp3); err != nil {
		cmd := exec.Command("ffmpeg", "-hide_banner", "-v", "error",
			"-f", "lavfi", "-i", "sine=frequency=440:duration=3",
			"-c:a", "libmp3lame", "-y", mp3)
		if err := cmd.Run(); err != nil {
			t.Skipf("ffmpeg gen: %v", err)
		}
	}
	sr, ch, samples, err := decodeTrack(mp3)
	if err != nil {
		t.Fatalf("decodeTrack: %v", err)
	}
	wav := wrapAsWAV(sr, ch, samples)
	out := "/tmp/accidia-go.wav"
	if err := os.WriteFile(out, wav, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %s sr=%d ch=%d samples=%d size=%d bytes",
		out, sr, ch, len(samples), len(wav))
}

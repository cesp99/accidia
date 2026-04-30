//go:build integration

package audio_test

import (
	"encoding/binary"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/cesp99/infinite-jukebox/internal/audio"
	"github.com/cesp99/infinite-jukebox/internal/ffmpeg"
	"github.com/cesp99/infinite-jukebox/internal/library"
	"github.com/cesp99/infinite-jukebox/internal/media"
	"github.com/cesp99/infinite-jukebox/internal/store"
)

// TestDecodeTrack_RealMP3 runs a real ffmpeg-generated MP3 through the full
// Library.DecodeTrack path and validates that the resulting WAV is playable.
// This is the actual user-facing path so if this works, the Go side of
// things is fine and any remaining bug is on the IPC / frontend side.
func TestDecodeTrack_RealMP3(t *testing.T) {
	tmp := t.TempDir()
	mp3 := filepath.Join(tmp, "test-440.mp3")

	cmd := exec.Command(
		"ffmpeg", "-hide_banner", "-v", "error",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=3",
		"-c:a", "libmp3lame", "-y", mp3,
	)
	if err := cmd.Run(); err != nil {
		t.Skipf("could not build mp3 fixture: %v", err)
	}

	// Go-side decode: MP3 → WAV → sanity check → re-parse WAV.
	sr, ch, samples, err := audio.DecodeTrack(mp3)
	if err != nil {
		t.Fatalf("DecodeTrack mp3: %v", err)
	}
	if sr == 0 || ch == 0 || len(samples) == 0 {
		t.Fatalf("empty decode: sr=%d ch=%d len=%d", sr, ch, len(samples))
	}
	t.Logf("DecodeTrack -> sr=%d ch=%d samples=%d duration=%.2fs",
		sr, ch, len(samples), float64(len(samples)/ch)/float64(sr))

	// WrapAsWAV + re-decode to make sure the wrapped bytes round-trip.
	wav := audio.WrapAsWAV(sr, ch, samples)
	if len(wav) < 44 || string(wav[0:4]) != "RIFF" {
		t.Fatalf("invalid WAV output: %x", wav[:minInt(16, len(wav))])
	}
	ss, cc, pcm, err := audio.DecodeWAVBytes(wav)
	if err != nil {
		t.Fatalf("round-trip decode: %v", err)
	}
	if ss != sr || cc != ch || len(pcm) != len(samples) {
		t.Fatalf("round-trip mismatch: before sr=%d ch=%d len=%d, after sr=%d ch=%d len=%d",
			sr, ch, len(samples), ss, cc, len(pcm))
	}
	// Sanity check: look at a window well past any encoder delay padding
	// (libmp3lame pads ~1152 silent samples at the start).
	nonZero := 0
	start := minInt(len(pcm), 44100) // at ~1s in
	end := minInt(len(pcm), start+4410)
	for _, s := range pcm[start:end] {
		if s != 0 {
			nonZero++
		}
	}
	if nonZero == 0 {
		t.Fatalf("decoded PCM is all zeros in [%d,%d)", start, end)
	}
	t.Logf("non-zero samples in 100ms window at 1s: %d/%d", nonZero, end-start)

	// Now go through the library-level API that the frontend actually calls.
	ff := ffmpeg.New()
	st := store.New()
	md := media.New(3)
	lib := library.New(st, ff, md)
	out, err := lib.DecodeTrack(mp3)
	if err != nil {
		t.Fatalf("Library.DecodeTrack: %v", err)
	}
	if out.SampleRate != sr || out.Channels != ch {
		t.Fatalf("Library.DecodeTrack reported sr=%d ch=%d, want %d/%d",
			out.SampleRate, out.Channels, sr, ch)
	}
	if out.Frames != len(samples)/ch {
		t.Fatalf("Library.DecodeTrack reported frames=%d, want %d",
			out.Frames, len(samples)/ch)
	}
	if out.MediaURL == "" {
		t.Fatal("empty MediaURL")
	}
	t.Logf("Library.DecodeTrack -> sr=%d ch=%d frames=%d duration=%.2fs url=%s",
		out.SampleRate, out.Channels, out.Frames, out.Duration, out.MediaURL)

	// Write the produced WAV out so we can inspect if needed.
	wavOut := filepath.Join(tmp, "decoded.wav")
	if err := os.WriteFile(wavOut, wav, 0o644); err != nil {
		t.Fatal(err)
	}
	// Quick header validation.
	if sRate := binary.LittleEndian.Uint32(wav[24:28]); int(sRate) != sr {
		t.Errorf("WAV header sr=%d, want %d", sRate, sr)
	}
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

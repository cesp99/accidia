package audio_test

import (
	"encoding/binary"
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/cesp99/infinite-jukebox/internal/audio"
)

// makeSineWAV builds a synthetic 44.1k/stereo/16-bit sine WAV at the given
// path so we can round-trip it through DecodeTrack + WrapAsWAV.
func makeSineWAV(t *testing.T, dir string, seconds float64, freq float64) string {
	t.Helper()
	sr := 44100
	ch := 2
	n := int(float64(sr) * seconds)

	pcm := make([]int16, n*ch)
	for i := 0; i < n; i++ {
		v := int16(math.Sin(2*math.Pi*freq*float64(i)/float64(sr)) * 0.5 * 32767)
		pcm[i*2] = v
		pcm[i*2+1] = v
	}

	wav := audio.WrapAsWAV(sr, ch, pcm)
	path := filepath.Join(dir, "sine.wav")
	if err := os.WriteFile(path, wav, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestDecodeWAV_Roundtrip(t *testing.T) {
	dir := t.TempDir()
	path := makeSineWAV(t, dir, 0.5, 440)

	sr, ch, samples, err := audio.DecodeTrack(path)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if sr != 44100 {
		t.Errorf("sample rate = %d, want 44100", sr)
	}
	if ch != 2 {
		t.Errorf("channels = %d, want 2", ch)
	}
	wantSamples := int(0.5*44100) * 2
	if len(samples) != wantSamples {
		t.Errorf("samples = %d, want %d", len(samples), wantSamples)
	}
}

func TestWrapAsWAV_Header(t *testing.T) {
	samples := make([]int16, 1000)
	for i := range samples {
		samples[i] = int16(i)
	}
	out := audio.WrapAsWAV(44100, 2, samples)

	if string(out[0:4]) != "RIFF" {
		t.Errorf("want RIFF got %q", string(out[0:4]))
	}
	if string(out[8:12]) != "WAVE" {
		t.Errorf("want WAVE got %q", string(out[8:12]))
	}
	if string(out[12:16]) != "fmt " {
		t.Errorf("want fmt got %q", string(out[12:16]))
	}
	// Expect PCM format (1)
	if binary.LittleEndian.Uint16(out[20:22]) != 1 {
		t.Errorf("want format 1, got %d", binary.LittleEndian.Uint16(out[20:22]))
	}
	// Channels = 2
	if binary.LittleEndian.Uint16(out[22:24]) != 2 {
		t.Errorf("want 2 channels, got %d", binary.LittleEndian.Uint16(out[22:24]))
	}
	// Sample rate
	if binary.LittleEndian.Uint32(out[24:28]) != 44100 {
		t.Errorf("want 44100, got %d", binary.LittleEndian.Uint32(out[24:28]))
	}
}

func TestDecodeWAV_IEEEFloat(t *testing.T) {
	// Build a tiny IEEE-float WAV by hand, then decode it.
	dir := t.TempDir()
	path := filepath.Join(dir, "float.wav")

	data := make([]byte, 0, 1024)
	appendU32 := func(v uint32) {
		b := make([]byte, 4)
		binary.LittleEndian.PutUint32(b, v)
		data = append(data, b...)
	}
	appendU16 := func(v uint16) {
		b := make([]byte, 2)
		binary.LittleEndian.PutUint16(b, v)
		data = append(data, b...)
	}

	// 2 samples at 8kHz, mono, 32-bit float
	numSamples := 2
	pcm := make([]byte, numSamples*4)
	binary.LittleEndian.PutUint32(pcm[0:4], math.Float32bits(0.5))
	binary.LittleEndian.PutUint32(pcm[4:8], math.Float32bits(-0.5))

	data = append(data, []byte("RIFF")...)
	appendU32(36 + uint32(len(pcm)))
	data = append(data, []byte("WAVE")...)
	data = append(data, []byte("fmt ")...)
	appendU32(16)       // fmt chunk size
	appendU16(3)        // IEEE float
	appendU16(1)        // channels
	appendU32(8000)     // sample rate
	appendU32(8000 * 4) // byte rate
	appendU16(4)        // block align
	appendU16(32)       // bits per sample
	data = append(data, []byte("data")...)
	appendU32(uint32(len(pcm)))
	data = append(data, pcm...)

	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	sr, ch, out, err := audio.DecodeTrack(path)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if sr != 8000 || ch != 1 {
		t.Errorf("sr=%d ch=%d, want 8000/1", sr, ch)
	}
	if len(out) != 2 {
		t.Fatalf("samples = %d, want 2", len(out))
	}
	// 0.5 → ~16383, -0.5 → ~-16383
	if out[0] < 16000 || out[0] > 17000 {
		t.Errorf("sample[0] = %d, want ~16383", out[0])
	}
	if out[1] < -17000 || out[1] > -16000 {
		t.Errorf("sample[1] = %d, want ~-16383", out[1])
	}
}

func TestDecodeTrack_FallsBackToFFmpeg(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "junk.xyz")
	if err := os.WriteFile(path, []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, _, _, err := audio.DecodeTrack(path)
	if err == nil {
		t.Fatal("expected error for unsupported extension")
	}
	if err != audio.ErrNeedsFFmpeg {
		t.Errorf("want ErrNeedsFFmpeg, got %v", err)
	}
}

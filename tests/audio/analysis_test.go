package audio_test

import (
	"math"
	"testing"

	"github.com/cesp99/infinite-jukebox/internal/audio"
)

// makePulseTrain builds a stereo int16 buffer with short loud pulses
// every `bpm` beats per minute over `seconds` of silence at sampleRate
// `sr`. The amplitude is high enough that the energy envelope picks
// up the pulses cleanly even after smoothing.
func makePulseTrain(t *testing.T, sr int, seconds float64, bpm float64) []int16 {
	t.Helper()
	n := int(float64(sr) * seconds)
	out := make([]int16, n*2)
	beatPeriod := int(60.0 / bpm * float64(sr))
	pulseLen := sr / 50 // ~20ms pulse
	for i := 0; i < n; i += beatPeriod {
		for j := 0; j < pulseLen && i+j < n; j++ {
			// Window the pulse so it doesn't read as a click; a quick
			// triangular envelope is plenty for the onset detector.
			env := float64(pulseLen-j) / float64(pulseLen)
			v := int16(0.6 * 32767 * env)
			out[(i+j)*2] = v
			out[(i+j)*2+1] = v
		}
	}
	return out
}

func TestAnalyzeInt16_DetectsBpm(t *testing.T) {
	const sr = 44100
	const expectedBPM = 120.0
	samples := makePulseTrain(t, sr, 8.0, expectedBPM)

	got := audio.AnalyzeInt16(samples, 2, sr, 8.0, "Test - Pulse Train")
	// Beat count: 120 BPM × 8s = 16 beats. Allow a little slack for
	// the onset detector missing the very first/last partial pulse.
	if got.NBeats < 12 || got.NBeats > 20 {
		t.Fatalf("unexpected beat count: got %d, want ~16", got.NBeats)
	}
	// Tempo estimate within 5% — the median-of-medians fold has
	// some headroom but not much for a clean pulse train.
	if math.Abs(got.BPM-expectedBPM) > expectedBPM*0.05 {
		t.Fatalf("BPM off: got %.2f, want %.2f", got.BPM, expectedBPM)
	}
	if got.Title != "Test - Pulse Train" {
		t.Fatalf("title not preserved: got %q", got.Title)
	}
}

func TestAnalyzeInt16_ParentheticalsStripped(t *testing.T) {
	const sr = 22050
	// Tiny silent input — we only care about the title-cleaning side
	// effect here, not the beat output.
	samples := make([]int16, sr/2*2)

	got := audio.AnalyzeInt16(samples, 2, sr, 0.5, "Track Name (Remastered 2011) [Bonus]")
	if got.Title != "Track Name" {
		t.Fatalf("expected stripped title, got %q", got.Title)
	}
}

func TestAnalyzeInt16_HandlesShortAndDegenerateInput(t *testing.T) {
	// Empty samples → must not panic, must return a sensible
	// duration so the engine can place a loop point.
	got := audio.AnalyzeInt16(nil, 2, 44100, 0, "")
	if got.NBeats > 0 {
		t.Fatalf("expected zero beats for empty input, got %d", got.NBeats)
	}

	// Very short silent buffer — still no beats, but no panic and a
	// non-negative duration.
	short := make([]int16, 1000)
	got = audio.AnalyzeInt16(short, 1, 44100, 0.02, "blip")
	if got.Duration < 0 {
		t.Fatalf("negative duration on short input: %f", got.Duration)
	}
}

func TestAnalyzeInt16_BuildsEdgesFromRepeatedSections(t *testing.T) {
	// Repeating the same pulse train back-to-back should produce
	// edges between equivalent beats in the two halves.
	const sr = 44100
	half := makePulseTrain(t, sr, 6.0, 120.0)
	full := append(half, half...) // 12 seconds, identical halves

	got := audio.AnalyzeInt16(full, 2, sr, 12.0, "")
	if len(got.Edges) == 0 {
		t.Fatalf("expected at least one similarity edge, got 0")
	}
	for _, e := range got.Edges {
		if e.From == e.To {
			t.Fatalf("self-edge detected: %+v", e)
		}
		if e.From < 0 || e.To < 0 || e.From >= got.NBeats || e.To >= got.NBeats {
			t.Fatalf("edge index out of range: %+v (n=%d)", e, got.NBeats)
		}
		if e.Similarity < 0 || e.Similarity > 1 {
			t.Fatalf("similarity out of range: %+v", e)
		}
	}
}

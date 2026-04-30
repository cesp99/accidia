package audio

import (
	"math"
	"sort"
	"strings"
)

// Analysis is the beat-graph payload the frontend consumes to drive
// the Infinite Jukebox engine. Field names match the TypeScript
// `AnalysisData` interface so the JSON-bridge marshalling on the
// frontend can stay unchanged.
type Analysis struct {
	Title    string  `json:"title"`
	BPM      float64 `json:"bpm"`
	Duration float64 `json:"duration"`
	NBeats   int     `json:"n_beats"`
	Beats    []Beat  `json:"beats"`
	Edges    []Edge  `json:"edges"`
}

// Beat is a single beat onset on the timeline. Index is the position
// within the Beats slice (so callers can pre-index by integer key);
// Time is the absolute offset in seconds.
type Beat struct {
	Index int     `json:"index"`
	Time  float64 `json:"time"`
}

// Edge connects two beats whose audio neighbourhoods sound similar
// enough that the player can silently jump from one to the other.
// Similarity is the cosine similarity in [0, 1].
type Edge struct {
	From       int     `json:"from"`
	To         int     `json:"to"`
	Similarity float64 `json:"similarity"`
}

// Tunables. Mirror the TypeScript implementation in audio-analysis.ts
// exactly so the two paths produce equivalent beat grids — moving the
// pipeline to Go is purely a perf change, not a re-tuning.
const (
	analysisMaxSeconds       = 300
	analysisFrameSize        = 1024
	analysisHopSize          = 512
	analysisMinBeatSpacing   = 0.25 // seconds between accepted onsets
	analysisFluxThresholdMul = 1.35
	analysisSmoothWindow     = 4  // ±radius for the energy smoothing pass
	analysisBaselineWindow   = 16 // ±radius for the flux baseline
	analysisStrongEdgeThresh = 0.95
	analysisRelaxedEdgeThres = 0.88
	analysisEdgeFloor        = 12  // fall back to relaxed threshold below this many strong edges
	analysisMaxEdges         = 600 // safety cap; beat graphs blow up quadratically otherwise
)

// AnalyzeInt16 runs the full beat-detection + edge-graph pipeline on
// interleaved int16 PCM. This is the Go-side replacement for the
// `runAnalysis` chain in the frontend's audio-analysis.ts: it
// off-loads the ~500-1500ms of single-threaded JS work onto a Go
// goroutine where it doesn't compete with the React render loop.
//
// The function is deliberately self-contained — no shared state, no
// FFI back into the host — so callers can wrap it in whatever caching
// strategy they want (the library package layers a disk cache on top).
//
// `samples` is the same int16 PCM that ends up in the MediaStore;
// `channels` controls the mono mixdown. `sampleRate` and
// `fullDuration` are the values reported by the decoder. `displayName`
// is the title shown in the now-playing UI; we strip parenthetical
// suffixes ("(Remastered 2011)" etc.) to match the historical TS
// behaviour.
func AnalyzeInt16(samples []int16, channels, sampleRate int, fullDuration float64, displayName string) Analysis {
	if channels < 1 {
		channels = 1
	}
	if sampleRate <= 0 {
		// Pathological input — return an empty stand-in so callers can
		// still place a track-end loop point at 0.
		return Analysis{
			Title:    normalizeTitle(displayName),
			Duration: math.Max(0, math.Min(fullDuration, analysisMaxSeconds)),
		}
	}

	cap := int64(sampleRate) * int64(channels) * int64(analysisMaxSeconds)
	if int64(len(samples)) > cap {
		samples = samples[:cap]
	}

	mono := monoMixdown(samples, channels)
	duration := math.Min(fullDuration, analysisMaxSeconds)
	return runAnalysis(mono, sampleRate, duration, displayName)
}

// runAnalysis is the inner orchestrator. Split out so callers that
// already hold a mono Float32 buffer (rare in practice) can skip the
// mixdown.
func runAnalysis(mono []float64, sampleRate int, duration float64, displayName string) Analysis {
	beatTimes := detectBeatTimes(mono, sampleRate, duration)
	if len(beatTimes) < 4 {
		// Not enough rhythm — emit a flat half-second grid. This
		// matches what the TS path does on its fallback so the
		// engine has something to loop.
		return Analysis{
			Title:    normalizeTitle(displayName),
			BPM:      120,
			Duration: roundTo(duration, 2),
			NBeats:   0,
			Beats:    []Beat{},
			Edges:    []Edge{},
		}
	}

	bpm := estimateBPM(beatTimes)
	beats := make([]Beat, len(beatTimes))
	for i, t := range beatTimes {
		beats[i] = Beat{Index: i, Time: roundTo(t, 4)}
	}

	edges := buildEdges(beats, mono, sampleRate, duration, bpm)

	return Analysis{
		Title:    normalizeTitle(displayName),
		BPM:      roundTo(bpm, 2),
		Duration: roundTo(duration, 2),
		NBeats:   len(beats),
		Beats:    beats,
		Edges:    edges,
	}
}

// monoMixdown averages interleaved int16 samples into a normalised
// (-1..1) float64 mono buffer. We use float64 for the analysis so
// rounding behaviour matches the JS reference; the storage hit is
// transient (the slice is freed once the analysis returns).
func monoMixdown(samples []int16, channels int) []float64 {
	frames := len(samples) / channels
	out := make([]float64, frames)
	if channels == 1 {
		for i := 0; i < frames; i++ {
			out[i] = float64(samples[i]) / 32768.0
		}
		return out
	}
	scale := 1.0 / (32768.0 * float64(channels))
	for i := 0; i < frames; i++ {
		base := i * channels
		var sum int64
		for c := 0; c < channels; c++ {
			sum += int64(samples[base+c])
		}
		out[i] = float64(sum) * scale
	}
	return out
}

// computeEnergyEnvelope computes a per-frame RMS of `mono` using the
// usual short-time-energy hop scheme.
func computeEnergyEnvelope(mono []float64) []float64 {
	if len(mono) < analysisFrameSize {
		return nil
	}
	nFrames := 1 + (len(mono)-analysisFrameSize)/analysisHopSize
	out := make([]float64, nFrames)
	for i := 0; i < nFrames; i++ {
		start := i * analysisHopSize
		var sumSq float64
		for j := 0; j < analysisFrameSize; j++ {
			s := mono[start+j]
			sumSq += s * s
		}
		out[i] = math.Sqrt(sumSq / float64(analysisFrameSize))
	}
	return out
}

// movingAverage applies a centred boxcar of half-width `radius` over
// `values`. Edges are clipped (i.e. the average is taken over fewer
// samples there) so output length matches input length.
func movingAverage(values []float64, radius int) []float64 {
	if len(values) == 0 {
		return nil
	}
	out := make([]float64, len(values))
	for i := range values {
		from := i - radius
		if from < 0 {
			from = 0
		}
		to := i + radius
		if to > len(values)-1 {
			to = len(values) - 1
		}
		var sum float64
		count := to - from + 1
		for j := from; j <= to; j++ {
			sum += values[j]
		}
		out[i] = sum / float64(count)
	}
	return out
}

// detectBeatTimes runs the energy → smoothing → flux → peak-pick chain
// to produce candidate beat timestamps in seconds.
func detectBeatTimes(mono []float64, sampleRate int, duration float64) []float64 {
	energy := computeEnergyEnvelope(mono)
	if len(energy) == 0 {
		return nil
	}

	smooth := movingAverage(energy, analysisSmoothWindow)
	flux := make([]float64, len(smooth))
	for i := 1; i < len(smooth); i++ {
		d := smooth[i] - smooth[i-1]
		if d > 0 {
			flux[i] = d
		}
	}
	baseline := movingAverage(flux, analysisBaselineWindow)

	minFrameDist := int(math.Floor((analysisMinBeatSpacing * float64(sampleRate)) / float64(analysisHopSize)))
	if minFrameDist < 1 {
		minFrameDist = 1
	}
	lastFrame := -minFrameDist
	beatFrames := make([]int, 0, len(flux)/8)
	for i := 1; i < len(flux)-1; i++ {
		threshold := baseline[i] * analysisFluxThresholdMul
		isPeak := flux[i] > flux[i-1] && flux[i] >= flux[i+1]
		if isPeak && flux[i] > threshold && i-lastFrame >= minFrameDist {
			beatFrames = append(beatFrames, i)
			lastFrame = i
		}
	}

	beatTimes := make([]float64, len(beatFrames))
	for i, f := range beatFrames {
		beatTimes[i] = float64(f*analysisHopSize) / float64(sampleRate)
	}

	// Fallback: if we couldn't find anything beat-like, lay down a
	// regular half-second grid so the player still has an end-of-
	// track loop point.
	if len(beatTimes) < 4 {
		const fallbackStep = 0.5
		count := int(duration / fallbackStep)
		if count <= 0 {
			return []float64{0}
		}
		grid := make([]float64, count)
		for i := 0; i < count; i++ {
			grid[i] = float64(i) * fallbackStep
		}
		return grid
	}

	return beatTimes
}

// estimateBPM runs the median-of-medians dance the TS code did to
// fold tempo into the [70, 180] musical range.
func estimateBPM(beatTimes []float64) float64 {
	if len(beatTimes) < 2 {
		return 120
	}

	intervals := make([]float64, 0, len(beatTimes)-1)
	for i := 1; i < len(beatTimes); i++ {
		dt := beatTimes[i] - beatTimes[i-1]
		if dt >= 0.2 && dt <= 1.2 {
			intervals = append(intervals, dt)
		}
	}
	if len(intervals) == 0 {
		return 120
	}

	med := median(intervals)
	filtered := intervals[:0]
	for _, dt := range intervals {
		if dt >= med*0.6 && dt <= med*1.6 {
			filtered = append(filtered, dt)
		}
	}
	if len(filtered) == 0 {
		return 120
	}

	candidates := make([]float64, 0, len(filtered))
	for _, dt := range filtered {
		bpm := 60.0 / dt
		for bpm < 80 {
			bpm *= 2
		}
		for bpm > 170 {
			bpm /= 2
		}
		candidates = append(candidates, bpm)
	}

	bpm := median(candidates)
	switch {
	case bpm < 70:
		return 70
	case bpm > 180:
		return 180
	default:
		return bpm
	}
}

// sliceFeature derives a 5-element fingerprint of the audio between
// `start` and `end` seconds. Cheap (single linear pass), and enough to
// distinguish "verse-shaped chunk" from "chorus-shaped chunk" for the
// edge-graph similarity check.
func sliceFeature(mono []float64, sampleRate int, start, end float64) [5]float64 {
	n := len(mono)
	s := clampInt(int(math.Floor(start*float64(sampleRate))), 0, n)
	e := clampInt(int(math.Floor(end*float64(sampleRate))), s+1, n)
	length := e - s
	if length <= 0 {
		return [5]float64{}
	}

	var sum, sumSq, sumDiff, peak float64
	zc := 0
	prev := mono[s]
	for i := s; i < e; i++ {
		v := mono[i]
		av := math.Abs(v)
		sum += av
		sumSq += v * v
		if i > s {
			sumDiff += math.Abs(v - prev)
			if (v >= 0 && prev < 0) || (v < 0 && prev >= 0) {
				zc++
			}
		}
		if av > peak {
			peak = av
		}
		prev = v
	}

	lf := float64(length)
	meanAbs := sum / lf
	rms := math.Sqrt(sumSq / lf)
	zcr := float64(zc) / lf
	roughness := sumDiff / lf
	crest := peak / (rms + 1e-9)
	return [5]float64{meanAbs, rms, zcr, roughness, crest}
}

// cosineSimilarity over 5-vectors. Inlining avoids a slice allocation
// per pair, which matters because buildEdges is O(beats²).
func cosineSimilarity(a, b [5]float64) float64 {
	var dot, an, bn float64
	for i := 0; i < 5; i++ {
		dot += a[i] * b[i]
		an += a[i] * a[i]
		bn += b[i] * b[i]
	}
	denom := math.Sqrt(an) * math.Sqrt(bn)
	if denom == 0 {
		return 0
	}
	return dot / denom
}

// buildEdges runs every-pair-with-min-separation cosine similarity to
// find good jump candidates. Two thresholds: a strong cut for normal
// tracks, a relaxed cut as a fallback when the strong cut starves the
// graph (happens on very repetitive tracks where features clump).
func buildEdges(beats []Beat, mono []float64, sampleRate int, duration, bpm float64) []Edge {
	if len(beats) < 4 {
		return nil
	}

	feats := make([][5]float64, len(beats))
	for i := range beats {
		start := beats[i].Time
		var end float64
		if i+1 < len(beats) {
			end = beats[i+1].Time
		} else {
			end = math.Min(duration, start+60.0/math.Max(1, bpm))
		}
		feats[i] = sliceFeature(mono, sampleRate, start, end)
	}

	minSep := int(math.Floor(bpm / 15))
	if minSep < 4 {
		minSep = 4
	}

	edges := make([]Edge, 0, 64)
	for i := 0; i < len(beats); i++ {
		for j := i + minSep; j < len(beats); j++ {
			sim := cosineSimilarity(feats[i], feats[j])
			if sim >= analysisStrongEdgeThresh {
				edges = append(edges, Edge{From: i, To: j, Similarity: roundTo(sim, 4)})
			}
		}
	}

	if len(edges) < analysisEdgeFloor {
		// Strong cut starved us — fall back to the relaxed threshold
		// for the deficit. Don't *replace* the strong edges; we want
		// both pools so we can prefer high-similarity jumps.
		for i := 0; i < len(beats); i++ {
			for j := i + minSep; j < len(beats); j++ {
				sim := cosineSimilarity(feats[i], feats[j])
				if sim >= analysisRelaxedEdgeThres && sim < analysisStrongEdgeThresh {
					edges = append(edges, Edge{From: i, To: j, Similarity: roundTo(sim, 4)})
				}
			}
		}
	}

	sort.Slice(edges, func(a, b int) bool {
		return edges[a].Similarity > edges[b].Similarity
	})
	if len(edges) > analysisMaxEdges {
		edges = edges[:analysisMaxEdges]
	}
	return edges
}

// median returns the middle value of `values`. Mutates a copy, never
// the caller's slice.
func median(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	cp := append([]float64(nil), values...)
	sort.Float64s(cp)
	mid := len(cp) / 2
	if len(cp)%2 == 0 {
		return (cp[mid-1] + cp[mid]) / 2
	}
	return cp[mid]
}

// normalizeTitle drops trailing parenthetical / bracketed suffixes to
// keep "(Remastered 2011)" etc. out of the now-playing display.
func normalizeTitle(name string) string {
	out := stripParens(name)
	out = collapseWhitespace(out)
	out = strings.TrimSpace(out)
	if out == "" {
		return name
	}
	return out
}

func stripParens(s string) string {
	var b strings.Builder
	depthRound, depthSquare := 0, 0
	for _, r := range s {
		switch r {
		case '(':
			depthRound++
		case ')':
			if depthRound > 0 {
				depthRound--
			}
		case '[':
			depthSquare++
		case ']':
			if depthSquare > 0 {
				depthSquare--
			}
		default:
			if depthRound == 0 && depthSquare == 0 {
				b.WriteRune(r)
			}
		}
	}
	return b.String()
}

func collapseWhitespace(s string) string {
	var b strings.Builder
	prevSpace := false
	for _, r := range s {
		if r == ' ' || r == '\t' {
			if !prevSpace {
				b.WriteByte(' ')
			}
			prevSpace = true
			continue
		}
		prevSpace = false
		b.WriteRune(r)
	}
	return b.String()
}

func roundTo(v float64, decimals int) float64 {
	pow := math.Pow(10, float64(decimals))
	return math.Round(v*pow) / pow
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

import type { AnalysisData, Beat, Edge } from "@/hooks/use-audio-engine";

const MAX_SECONDS = 300;
const FRAME_SIZE = 1024;
const HOP_SIZE = 512;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function makeMonoChannel(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const mono = new Float32Array(length);

  for (let ch = 0; ch < channels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) mono[i] += data[i] / channels;
  }

  return mono;
}

function computeEnergyEnvelope(mono: Float32Array): number[] {
  const energies: number[] = [];
  for (let start = 0; start + FRAME_SIZE <= mono.length; start += HOP_SIZE) {
    let sumSq = 0;
    for (let i = 0; i < FRAME_SIZE; i++) {
      const sample = mono[start + i];
      sumSq += sample * sample;
    }
    energies.push(Math.sqrt(sumSq / FRAME_SIZE));
  }
  return energies;
}

function movingAverage(values: number[], windowRadius: number): number[] {
  if (!values.length) return [];
  const out = new Array<number>(values.length).fill(0);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let count = 0;
    const from = Math.max(0, i - windowRadius);
    const to = Math.min(values.length - 1, i + windowRadius);
    for (let j = from; j <= to; j++) {
      sum += values[j];
      count++;
    }
    out[i] = sum / count;
  }
  return out;
}

function estimateBpm(beatTimes: number[]): number {
  if (beatTimes.length < 2) return 120;

  const intervals: number[] = [];
  for (let i = 1; i < beatTimes.length; i++) {
    const dt = beatTimes[i] - beatTimes[i - 1];
    if (dt >= 0.2 && dt <= 1.2) intervals.push(dt);
  }
  if (!intervals.length) return 120;

  const med = median(intervals);
  const filtered = intervals.filter((dt) => dt >= med * 0.6 && dt <= med * 1.6);
  if (!filtered.length) return 120;

  const candidateBpms = filtered.map((dt) => {
    let bpm = 60 / dt;
    // Fold tempo into a musical range to avoid half/double-time extremes.
    while (bpm < 80) bpm *= 2;
    while (bpm > 170) bpm /= 2;
    return bpm;
  });

  return clamp(median(candidateBpms), 70, 180);
}

function detectBeatTimes(mono: Float32Array, sampleRate: number, duration: number): number[] {
  const energy = computeEnergyEnvelope(mono);
  if (!energy.length) return [];

  const smooth = movingAverage(energy, 4);
  const flux = smooth.map((v, i) => (i === 0 ? 0 : Math.max(0, v - smooth[i - 1])));
  const baseline = movingAverage(flux, 16);
  const beatFrames: number[] = [];
  const minSeparationSeconds = 0.25;
  const minFrameDistance = Math.max(1, Math.floor((minSeparationSeconds * sampleRate) / HOP_SIZE));

  let lastFrame = -minFrameDistance;
  for (let i = 1; i < flux.length - 1; i++) {
    const threshold = baseline[i] * 1.35;
    const isPeak = flux[i] > flux[i - 1] && flux[i] >= flux[i + 1];
    if (isPeak && flux[i] > threshold && i - lastFrame >= minFrameDistance) {
      beatFrames.push(i);
      lastFrame = i;
    }
  }

  let beatTimes = beatFrames.map((f) => (f * HOP_SIZE) / sampleRate);

  // Fallback for very sparse detection: place regular beats.
  if (beatTimes.length < 4) {
    const fallbackStep = 0.5;
    beatTimes = [];
    for (let t = 0; t < duration; t += fallbackStep) {
      beatTimes.push(t);
    }
  }

  return beatTimes;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    an += a[i] * a[i];
    bn += b[i] * b[i];
  }
  const denom = Math.sqrt(an) * Math.sqrt(bn);
  return denom > 0 ? dot / denom : 0;
}

function sliceFeature(mono: Float32Array, sampleRate: number, start: number, end: number): number[] {
  const s = clamp(Math.floor(start * sampleRate), 0, mono.length);
  const e = clamp(Math.floor(end * sampleRate), s + 1, mono.length);
  const len = e - s;
  if (len <= 0) return [0, 0, 0, 0, 0];

  let sum = 0;
  let sumSq = 0;
  let zc = 0;
  let sumDiff = 0;
  let peak = 0;
  let prev = mono[s];

  for (let i = s; i < e; i++) {
    const v = mono[i];
    const av = Math.abs(v);
    sum += av;
    sumSq += v * v;
    if (i > s) {
      sumDiff += Math.abs(v - prev);
      if ((v >= 0 && prev < 0) || (v < 0 && prev >= 0)) zc++;
    }
    if (av > peak) peak = av;
    prev = v;
  }

  const meanAbs = sum / len;
  const rms = Math.sqrt(sumSq / len);
  const zcr = zc / len;
  const roughness = sumDiff / len;
  const crest = peak / (rms + 1e-9);

  return [meanAbs, rms, zcr, roughness, crest];
}

function buildEdges(beats: Beat[], mono: Float32Array, sampleRate: number, duration: number, bpm: number): Edge[] {
  if (beats.length < 4) return [];

  const features: number[][] = [];
  for (let i = 0; i < beats.length; i++) {
    const start = beats[i].time;
    const end = beats[i + 1]?.time ?? Math.min(duration, start + 60 / Math.max(1, bpm));
    features.push(sliceFeature(mono, sampleRate, start, end));
  }

  const minSeparation = Math.max(4, Math.floor(bpm / 15));
  const edges: Edge[] = [];
  const strongThreshold = 0.95;
  const relaxedThreshold = 0.88;

  for (let i = 0; i < beats.length; i++) {
    for (let j = i + minSeparation; j < beats.length; j++) {
      const similarity = cosineSimilarity(features[i], features[j]);
      if (similarity >= strongThreshold) {
        edges.push({ from: i, to: j, similarity: Number(similarity.toFixed(4)) });
      }
    }
  }

  if (edges.length < 12) {
    for (let i = 0; i < beats.length; i++) {
      for (let j = i + minSeparation; j < beats.length; j++) {
        const similarity = cosineSimilarity(features[i], features[j]);
        if (similarity >= relaxedThreshold && similarity < strongThreshold) {
          edges.push({ from: i, to: j, similarity: Number(similarity.toFixed(4)) });
        }
      }
    }
  }

  edges.sort((a, b) => b.similarity - a.similarity);
  return edges.slice(0, 600);
}

export async function analyzeAudioFile(file: File): Promise<AnalysisData> {
  const arrayBuffer = await file.arrayBuffer();
  const rawTitle = file.name.replace(/\.[^/.]+$/, "");
  return analyzeAudioBuffer(arrayBuffer, rawTitle);
}

/**
 * Analyse raw audio bytes (e.g. a compressed MP3 / WAV buffer) by
 * decoding through Web Audio first. Used by the legacy file-upload path.
 */
export async function analyzeAudioBuffer(
  arrayBuffer: ArrayBuffer,
  displayName: string,
): Promise<AnalysisData> {
  const audioCtx = new AudioContext();
  try {
    const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));

    const maxSamples = Math.floor(decoded.sampleRate * MAX_SECONDS);
    const duration = Math.min(decoded.duration, MAX_SECONDS);
    const mono = makeMonoChannel(decoded).subarray(0, Math.min(decoded.length, maxSamples));

    return runAnalysis(mono, decoded.sampleRate, duration, displayName);
  } finally {
    await audioCtx.close();
  }
}

/**
 * Analyse a pre-built mono Float32 preview. Used by the new native-Go
 * decoder path — the PCM is already in memory and there's no need to
 * round-trip through `decodeAudioData`.
 */
export function analyzeMonoPcm(
  mono: Float32Array,
  sampleRate: number,
  fullDuration: number,
  displayName: string,
): AnalysisData {
  const cap = Math.min(mono.length, Math.floor(sampleRate * MAX_SECONDS));
  const truncated = cap < mono.length ? mono.subarray(0, cap) : mono;
  const duration = Math.min(fullDuration, MAX_SECONDS);
  return runAnalysis(truncated, sampleRate, duration, displayName);
}

function runAnalysis(
  mono: Float32Array,
  sampleRate: number,
  duration: number,
  displayName: string,
): AnalysisData {
  const beatTimes = detectBeatTimes(mono, sampleRate, duration);
  if (beatTimes.length < 4) {
    throw new Error("Not enough beats detected. Try a more rhythmic song.");
  }

  const bpm = estimateBpm(beatTimes);
  const beats: Beat[] = beatTimes.map((time, index) => ({
    index,
    time: Number(time.toFixed(4)),
  }));

  const edges = buildEdges(beats, mono, sampleRate, duration, bpm);

  const normalizedTitle = displayName
    .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return {
    title: normalizedTitle || displayName,
    bpm: Number(bpm.toFixed(2)),
    duration: Number(duration.toFixed(2)),
    n_beats: beats.length,
    beats,
    edges,
  };
}

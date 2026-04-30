// Utilities for dealing with raw int16 PCM bytes produced by the Go
// decoder. We bypass `AudioContext.decodeAudioData` entirely by building
// an `AudioBuffer` manually, which avoids flaky container-decoding paths
// in system webviews (notably WebKit2GTK on Linux).

/**
 * Fetch raw little-endian int16 PCM bytes from a URL served by the
 * Wails asset server and return an Int16Array view over them.
 */
export async function fetchPcm(url: string): Promise<Int16Array> {
  const resp = await fetch(url, { cache: "no-cache" });
  if (!resp.ok) {
    throw new Error(`media fetch failed: ${resp.status} ${resp.statusText}`);
  }
  const buf = await resp.arrayBuffer();
  return new Int16Array(buf);
}

/**
 * Build an `AudioBuffer` by hand from interleaved int16 PCM. This uses
 * only primitive Web Audio APIs (`createBuffer`, `copyToChannel`) so it
 * works on every webview regardless of codec-plugin availability.
 */
export function pcmToAudioBuffer(
  ctx: BaseAudioContext,
  pcm: Int16Array,
  sampleRate: number,
  channels: number,
  frames?: number,
): AudioBuffer {
  if (channels < 1) throw new Error(`invalid channel count ${channels}`);
  const framesPerChannel = frames ?? Math.floor(pcm.length / channels);
  if (framesPerChannel <= 0) throw new Error("pcmToAudioBuffer: empty PCM");

  const buffer = ctx.createBuffer(channels, framesPerChannel, sampleRate);
  // For each channel, de-interleave and normalise to [-1, 1] float.
  // Using copyToChannel lets the AudioBuffer skip a copy internally.
  const tmp = new Float32Array(framesPerChannel);
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < framesPerChannel; i++) {
      tmp[i] = pcm[i * channels + c] / 32768;
    }
    buffer.copyToChannel(tmp, c);
  }
  return buffer;
}

/**
 * Mono-mixdown of interleaved int16 PCM, normalised to float. Used by
 * the beat-analysis path which only needs a single channel.
 */
export function pcmToMonoFloat32(pcm: Int16Array, channels: number): Float32Array {
  if (channels < 1) throw new Error(`invalid channel count ${channels}`);
  const frames = Math.floor(pcm.length / channels);
  const out = new Float32Array(frames);
  if (channels === 1) {
    for (let i = 0; i < frames; i++) out[i] = pcm[i] / 32768;
    return out;
  }
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm[i * channels + c];
    out[i] = sum / channels / 32768;
  }
  return out;
}

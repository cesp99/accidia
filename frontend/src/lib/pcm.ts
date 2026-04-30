// Utilities for dealing with raw int16 PCM bytes produced by the Go
// decoder. We bypass `AudioContext.decodeAudioData` entirely by building
// an `AudioBuffer` manually, which avoids flaky container-decoding paths
// in system webviews (notably WebKit2GTK on Linux).
//
// Note: there used to also be a `pcmToMonoFloat32` helper here for the
// in-browser beat analyzer. That pipeline now runs in Go (see
// `internal/audio/analysis.go`), so the JS path is just "fetch PCM,
// hand it to Web Audio". One less O(n) main-thread pass per track.

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

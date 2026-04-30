// Beat-graph analysis runs in Go now (`internal/audio/analysis.go`),
// off the React main thread, with disk caching by (path, mtime). The
// frontend just consumes the result inline from `DecodeTrack`.
//
// We keep only the minimal-analysis stand-in here — used as a defensive
// fallback when Go can't produce a usable beat grid (very short clips,
// silent files, etc.) so the engine still has *something* to loop.

import type { AnalysisData, Beat } from "@/hooks/use-audio-engine";

/** Cap the duration we describe so a corrupt tag can't claim a 10-hour song. */
const MAX_SECONDS = 300;

/**
 * Build a minimal stand-in AnalysisData from just a duration + title.
 *
 * Beat layout is a regular grid at `assumedBpm` BPM — good enough for
 * the looping-at-end-of-track behavior, not for jukebox jumps (those
 * need edges which require real analysis; we keep edges empty).
 */
export function buildMinimalAnalysis(
  duration: number,
  displayName: string,
  assumedBpm = 120,
): AnalysisData {
  const clampedDuration = Math.max(0, Math.min(duration, MAX_SECONDS));
  const step = 60 / Math.max(1, assumedBpm);
  const beats: Beat[] = [];
  for (let t = 0, i = 0; t < clampedDuration; t += step, i++) {
    beats.push({ index: i, time: Number(t.toFixed(4)) });
  }
  // Always start with a beat at 0 so the engine's "loop back to beats[0]"
  // behaviour at end-of-track is well-defined.
  if (beats.length === 0) beats.push({ index: 0, time: 0 });

  const normalizedTitle = displayName
    .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return {
    title: normalizedTitle || displayName,
    bpm: assumedBpm,
    duration: Number(clampedDuration.toFixed(2)),
    n_beats: beats.length,
    beats,
    edges: [],
  };
}

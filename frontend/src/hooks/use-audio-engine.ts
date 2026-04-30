import { useRef, useCallback, useState, useEffect } from "react";
import { EffectsChain, defaultEffectsState, type EffectsState } from "@/lib/audio-effects";

export interface Beat {
  index: number;
  time: number;
}

export interface Edge {
  from: number;
  to: number;
  similarity: number;
}

export interface AnalysisData {
  title: string;
  bpm: number;
  duration: number;
  n_beats: number;
  beats: Beat[];
  edges: Edge[];
}

export interface PlaybackState {
  isPlaying: boolean;
  currentBeat: number;
  currentTime: number;
  playedSeconds: number;
  jumpCount: number;
  lastJump: { from: number; to: number } | null;
}

// Build a jump map: beat index -> array of reachable beat indices
function buildJumpMap(beats: Beat[], edges: Edge[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const edge of edges) {
    if (!map.has(edge.from)) map.set(edge.from, []);
    if (!map.has(edge.to)) map.set(edge.to, []);
    map.get(edge.from)!.push(edge.to);
    map.get(edge.to)!.push(edge.from); // bidirectional
  }
  return map;
}

export interface JumpSettings {
  /** 0–1 probability of jumping at each eligible beat */
  jumpProbability: number;
  /** minimum seconds that must pass before the next jump */
  minSecondsBetweenJumps: number;
}

export type { EffectsState } from "@/lib/audio-effects";

export function useAudioEngine() {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const sourceGainRef = useRef<GainNode | null>(null);
  const effectsChainRef = useRef<EffectsChain | null>(null);
  const startTimeRef = useRef<number>(0);
  const startOffsetRef = useRef<number>(0);
  const lastLoopContextTimeRef = useRef<number | null>(null);
  const animFrameRef = useRef<number>(0);
  const jumpMapRef = useRef<Map<number, number[]>>(new Map());
  const beatsRef = useRef<Beat[]>([]);
  const lastJumpAudioTimeRef = useRef<number>(-Infinity);
  const jumpSettingsRef = useRef<JumpSettings>({
    jumpProbability: 0.25,
    minSecondsBetweenJumps: 2,
  });
  const effectsStateRef = useRef<EffectsState>(defaultEffectsState);
  const volumeRef = useRef<number>(1);
  // Whether the engine should auto-loop the current track when it reaches
  // the end. True keeps the Infinite Jukebox runtime happy (jumps dominate
  // but we still want a fallback); false means we defer to the caller via
  // `onTrackEndRef`, typically to advance the queue or stop playback.
  const shouldLoopRef = useRef<boolean>(true);
  const onTrackEndRef = useRef<(() => void) | null>(null);
  // Guards against double-firing onTrackEnd if rAF ticks multiple times
  // past the end-of-track threshold before the caller swaps the buffer.
  const trackEndFiredRef = useRef<boolean>(false);

  const playbackStateRef = useRef<PlaybackState>({
    isPlaying: false,
    currentBeat: 0,
    currentTime: 0,
    playedSeconds: 0,
    jumpCount: 0,
    lastJump: null,
  });

  const [playbackState, setPlaybackState] = useState<PlaybackState>({
    isPlaying: false,
    currentBeat: 0,
    currentTime: 0,
    playedSeconds: 0,
    jumpCount: 0,
    lastJump: null,
  });

  const updateState = useCallback((updates: Partial<PlaybackState>) => {
    playbackStateRef.current = { ...playbackStateRef.current, ...updates };
    setPlaybackState({ ...playbackStateRef.current });
  }, []);

  const ensureContext = useCallback((): AudioContext => {
    if (!audioCtxRef.current) {
      const Ctx =
        typeof window !== "undefined"
          ? (window.AudioContext ||
              (window as unknown as { webkitAudioContext?: typeof AudioContext })
                .webkitAudioContext)
          : undefined;
      if (!Ctx) throw new Error("Web Audio API not supported in this browser.");
      audioCtxRef.current = new Ctx();
    }
    if (!effectsChainRef.current && audioCtxRef.current) {
      const chain = new EffectsChain(audioCtxRef.current);
      chain.apply(effectsStateRef.current);
      chain.setMasterGain(volumeRef.current);
      chain.output.connect(audioCtxRef.current.destination);
      effectsChainRef.current = chain;
      // Fire-and-forget: warm up the worklet so first toggle is instant.
      chain.preload();
    }
    return audioCtxRef.current!;
  }, []);

  const getCurrentAudioTime = useCallback((): number => {
    if (!audioCtxRef.current || !playbackStateRef.current.isPlaying) return startOffsetRef.current;
    return startOffsetRef.current + (audioCtxRef.current.currentTime - startTimeRef.current);
  }, []);

  // Fade out and dispose the current source. Pass withFade=false when the
  // caller is about to start a new source right away (playFrom already
  // handles the crossfade in that case).
  const stopCurrentSource = useCallback((withFade = true) => {
    const ctx = audioCtxRef.current;
    const src = sourceRef.current;
    const gain = sourceGainRef.current;
    sourceRef.current = null;
    sourceGainRef.current = null;
    if (!src) return;

    try {
      if (withFade && ctx && gain) {
        const now = ctx.currentTime;
        const g = gain.gain;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(0, now + 0.012);
        src.stop(now + 0.015);
      } else {
        src.stop();
        src.disconnect();
        gain?.disconnect();
      }
    } catch (_) {}
  }, []);

  const playFrom = useCallback(
    (offset: number) => {
      const ctx = audioCtxRef.current;
      const chain = effectsChainRef.current;
      if (!ctx || !audioBufferRef.current || !chain) return;

      const now = ctx.currentTime;
      const fadeTime = 0.01; // 10ms crossfade keeps jumps click-free

      // Fade out the previous source and schedule its stop.
      const prevSrc = sourceRef.current;
      const prevGain = sourceGainRef.current;
      if (prevSrc && prevGain) {
        try {
          const g = prevGain.gain;
          g.cancelScheduledValues(now);
          g.setValueAtTime(g.value, now);
          g.linearRampToValueAtTime(0, now + fadeTime);
          prevSrc.stop(now + fadeTime + 0.005);
        } catch (_) {}
      }

      // Create a new source + its own gain so we can fade it in independently.
      const source = ctx.createBufferSource();
      source.buffer = audioBufferRef.current;
      const sourceGain = ctx.createGain();
      sourceGain.gain.setValueAtTime(0, now);
      sourceGain.gain.linearRampToValueAtTime(1, now + fadeTime);
      source.connect(sourceGain);
      sourceGain.connect(chain.input);
      source.start(0, offset);

      sourceRef.current = source;
      sourceGainRef.current = sourceGain;
      startTimeRef.current = now;
      startOffsetRef.current = offset;
    },
    [],
  );

  const runPlaybackLoop = useCallback(() => {
    const loop = () => {
      if (!playbackStateRef.current.isPlaying) return;

      const beats = beatsRef.current;
      if (!beats.length) return;

      const loopNow = audioCtxRef.current?.currentTime ?? null;
      let playedSeconds = playbackStateRef.current.playedSeconds;
      if (loopNow !== null && lastLoopContextTimeRef.current !== null) {
        playedSeconds += Math.max(0, loopNow - lastLoopContextTimeRef.current);
      }
      lastLoopContextTimeRef.current = loopNow;

      const currentAudioTime = getCurrentAudioTime();
      const duration = audioBufferRef.current?.duration ?? 0;

      // Find current beat index
      let currentBeatIdx = 0;
      for (let i = beats.length - 1; i >= 0; i--) {
        if (beats[i].time <= currentAudioTime) {
          currentBeatIdx = i;
          break;
        }
      }

      // Find next beat time
      const nextBeat = beats[currentBeatIdx + 1];
      const nextBeatTime = nextBeat?.time ?? duration;
      const timeToNextBeat = nextBeatTime - currentAudioTime;

      // Check if we should jump (within 30ms of next beat)
      if (timeToNextBeat < 0.03 && nextBeat) {
        const { jumpProbability, minSecondsBetweenJumps } = jumpSettingsRef.current;
        const jumpTargets = jumpMapRef.current.get(currentBeatIdx + 1) ?? [];
        const cooldownOk = currentAudioTime - lastJumpAudioTimeRef.current >= minSecondsBetweenJumps;
        const shouldJump =
          jumpTargets.length > 0 &&
          cooldownOk &&
          Math.random() < jumpProbability;

        if (shouldJump) {
          const targetBeatIdx = jumpTargets[Math.floor(Math.random() * jumpTargets.length)];
          const targetTime = beats[targetBeatIdx].time;

          lastJumpAudioTimeRef.current = currentAudioTime;
          playFrom(targetTime);
          updateState({
            currentBeat: targetBeatIdx,
            currentTime: targetTime,
            playedSeconds,
            jumpCount: playbackStateRef.current.jumpCount + 1,
            lastJump: { from: currentBeatIdx, to: targetBeatIdx },
          });
        } else {
          updateState({
            currentBeat: currentBeatIdx,
            currentTime: currentAudioTime,
            playedSeconds,
            lastJump: null,
          });
        }
      } else {
        // End-of-track handling. Fires at duration - 0.1s so we have a
        // little headroom before the buffer genuinely runs out.
        if (currentAudioTime >= duration - 0.1) {
          if (shouldLoopRef.current) {
            // Loop mode: seamless restart from beat 0. Used in Jukebox
            // mode and when the caller has repeat=one.
            playFrom(beats[0].time);
            updateState({ currentBeat: 0, currentTime: beats[0].time, playedSeconds });
          } else {
            // Advance mode: hand control to the caller (via onTrackEnd)
            // who will either load the next track or pause. We still
            // need to let the current rAF loop exit so we don't keep
            // firing the callback every 16ms.
            if (!trackEndFiredRef.current) {
              trackEndFiredRef.current = true;
              const cb = onTrackEndRef.current;
              if (cb) {
                // Dispatch asynchronously so callers can safely update
                // state (which will re-render and potentially unmount
                // this engine's consumer) without racing the rAF frame.
                queueMicrotask(cb);
              }
            }
            // Keep updating state so the UI sees we're still near the end
            // until the caller swaps the buffer.
            updateState({
              currentBeat: currentBeatIdx,
              currentTime: currentAudioTime,
              playedSeconds,
            });
          }
        } else {
          updateState({
            currentBeat: currentBeatIdx,
            currentTime: currentAudioTime,
            playedSeconds,
          });
        }
      }

      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);
  }, [getCurrentAudioTime, playFrom, updateState]);

  const loadAudio = useCallback(
    async (source: File | ArrayBuffer | AudioBuffer, analysisData: AnalysisData) => {
      const ctx = ensureContext();
      let buffer: AudioBuffer;
      if (source instanceof AudioBuffer) {
        buffer = source;
      } else {
        const arrayBuffer =
          source instanceof ArrayBuffer ? source.slice(0) : await source.arrayBuffer();
        buffer = await ctx.decodeAudioData(arrayBuffer);
      }

      // We're loading a new track — tear down any in-flight source from
      // the previous one and reset the playback cursor so the next
      // play()/playFrom() call starts from the top.
      //
      // CRITICAL: reset isPlaying to false here. After a track naturally
      // ends in advance-mode (queue advance), the rAF loop keeps the
      // "isPlaying" flag at true while it spins waiting for the caller
      // to swap the buffer. Without this reset, the upcoming play() call
      // would early-return on its idempotent guard and the new track
      // would be loaded but silent — exactly the "next song shows but
      // doesn't start" symptom users see when stepping through a queue.
      stopCurrentSource(false);
      cancelAnimationFrame(animFrameRef.current);
      startOffsetRef.current = 0;
      lastJumpAudioTimeRef.current = -Infinity;
      lastLoopContextTimeRef.current = null;
      trackEndFiredRef.current = false;
      updateState({
        isPlaying: false,
        currentBeat: 0,
        currentTime: 0,
        playedSeconds: 0,
        jumpCount: 0,
        lastJump: null,
      });

      audioBufferRef.current = buffer;
      beatsRef.current = analysisData.beats;
      jumpMapRef.current = buildJumpMap(analysisData.beats, analysisData.edges);
    },
    [ensureContext, stopCurrentSource, updateState],
  );

  /**
   * Replace the beat grid + jump map without touching the currently
   * loaded AudioBuffer. Used by the progressive-load path — we start
   * playback with a minimal analysis (evenly-spaced beats, no edges)
   * and swap in the real analysis once the heavy beat-detection
   * finishes in the background.
   */
  const updateAnalysis = useCallback((analysisData: AnalysisData) => {
    beatsRef.current = analysisData.beats;
    jumpMapRef.current = buildJumpMap(analysisData.beats, analysisData.edges);
  }, []);

  // Exposes the engine's AudioContext so callers can manually build
  // AudioBuffers from raw PCM and pass them to loadAudio without a
  // second context spin-up.
  const getContext = useCallback((): AudioContext => ensureContext(), [ensureContext]);

  const play = useCallback(() => {
    const ctx = audioCtxRef.current;
    if (!audioBufferRef.current || !ctx) return;

    if (ctx.state === "suspended") ctx.resume();

    // Idempotent when already playing: without this guard a second
    // play() (e.g. from a media key when the OS re-sends Play instead
    // of PlayPause) restarts the source from `startOffsetRef.current`,
    // which is the last *playFrom* offset — usually 0 on a fresh
    // load — and the song appears to jump back to the beginning.
    if (playbackStateRef.current.isPlaying) return;

    const offset = startOffsetRef.current;
    playFrom(offset);
    lastLoopContextTimeRef.current = ctx.currentTime;
    updateState({ isPlaying: true });
    runPlaybackLoop();
  }, [playFrom, updateState, runPlaybackLoop]);

  const pause = useCallback(() => {
    if (audioCtxRef.current && lastLoopContextTimeRef.current !== null) {
      const delta = Math.max(0, audioCtxRef.current.currentTime - lastLoopContextTimeRef.current);
      updateState({ playedSeconds: playbackStateRef.current.playedSeconds + delta });
    }
    lastLoopContextTimeRef.current = null;
    cancelAnimationFrame(animFrameRef.current);
    stopCurrentSource();
    startOffsetRef.current = getCurrentAudioTime();
    updateState({ isPlaying: false });
  }, [stopCurrentSource, getCurrentAudioTime, updateState]);

  const seek = useCallback((beatIndex: number) => {
    const beats = beatsRef.current;
    if (!beats[beatIndex]) return;
    const time = beats[beatIndex].time;
    startOffsetRef.current = time;
    trackEndFiredRef.current = false; // seeking away from the end re-arms onTrackEnd

    if (playbackStateRef.current.isPlaying) {
      playFrom(time);
    }
    updateState({ currentBeat: beatIndex, currentTime: time });
  }, [playFrom, updateState]);

  const seekToTime = useCallback((timeSeconds: number) => {
    const beats = beatsRef.current;
    if (!beats.length) return;

    const maxDuration = audioBufferRef.current?.duration ?? beats[beats.length - 1].time;
    const clamped = Math.max(0, Math.min(timeSeconds, maxDuration));
    startOffsetRef.current = clamped;
    trackEndFiredRef.current = false; // seeking away from the end re-arms onTrackEnd

    let nearestBeatIdx = 0;
    let nearestDistance = Infinity;
    for (let i = 0; i < beats.length; i++) {
      const distance = Math.abs(beats[i].time - clamped);
      if (distance < nearestDistance) {
        nearestBeatIdx = i;
        nearestDistance = distance;
      }
    }

    if (playbackStateRef.current.isPlaying) {
      playFrom(clamped);
      if (audioCtxRef.current) {
        lastLoopContextTimeRef.current = audioCtxRef.current.currentTime;
      }
    }

    updateState({ currentBeat: nearestBeatIdx, currentTime: clamped });
  }, [playFrom, updateState]);

  const setJumpSettings = useCallback((partial: Partial<JumpSettings>) => {
    jumpSettingsRef.current = { ...jumpSettingsRef.current, ...partial };
  }, []);

  const setEffectsState = useCallback((state: EffectsState) => {
    effectsStateRef.current = state;
    effectsChainRef.current?.apply(state);
  }, []);

  const setVolume = useCallback((volume: number) => {
    const v = Math.max(0, Math.min(1.5, volume));
    volumeRef.current = v;
    effectsChainRef.current?.setMasterGain(v);
  }, []);

  /** Toggle whether the engine auto-loops the current track at end. */
  const setShouldLoop = useCallback((loop: boolean) => {
    shouldLoopRef.current = loop;
    if (loop) {
      // Leaving advance-mode: re-arm the fired flag so if we later flip
      // back and the track happens to be near its end, onTrackEnd fires
      // again as expected.
      trackEndFiredRef.current = false;
    }
  }, []);

  /**
   * Register a callback fired when the current track naturally reaches
   * its end AND shouldLoop is false. Exactly one fire per track-end —
   * reset by loading a new track or seeking away from the tail.
   */
  const setOnTrackEnd = useCallback((cb: (() => void) | null) => {
    onTrackEndRef.current = cb;
  }, []);

  const reset = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    stopCurrentSource();
    audioBufferRef.current = null;
    beatsRef.current = [];
    jumpMapRef.current = new Map();
    startOffsetRef.current = 0;
    lastJumpAudioTimeRef.current = -Infinity;
    lastLoopContextTimeRef.current = null;
    updateState({
      isPlaying: false,
      currentBeat: 0,
      currentTime: 0,
      playedSeconds: 0,
      jumpCount: 0,
      lastJump: null,
    });
  }, [stopCurrentSource, updateState]);

  // Tear down completely on unmount.
  useEffect(() => {
    return () => {
      cancelAnimationFrame(animFrameRef.current);
      try {
        sourceRef.current?.stop();
        sourceRef.current?.disconnect();
      } catch (_) {}
      effectsChainRef.current?.dispose();
      effectsChainRef.current = null;
      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
        audioCtxRef.current.close().catch(() => {});
      }
      audioCtxRef.current = null;
    };
  }, []);

  return {
    loadAudio,
    updateAnalysis,
    getContext,
    play,
    pause,
    seek,
    seekToTime,
    reset,
    setJumpSettings,
    setEffectsState,
    setVolume,
    setShouldLoop,
    setOnTrackEnd,
    playbackState,
    getCurrentAudioTime,
  };
}

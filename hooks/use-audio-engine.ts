"use client";

import { useRef, useCallback, useState } from "react";

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

export function useAudioEngine() {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
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

  const getCurrentAudioTime = useCallback((): number => {
    if (!audioCtxRef.current || !playbackStateRef.current.isPlaying) return startOffsetRef.current;
    return startOffsetRef.current + (audioCtxRef.current.currentTime - startTimeRef.current);
  }, []);

  const stopCurrentSource = useCallback(() => {
    if (sourceRef.current) {
      try {
        sourceRef.current.stop();
        sourceRef.current.disconnect();
      } catch (_) {}
      sourceRef.current = null;
    }
  }, []);

  const playFrom = useCallback((offset: number) => {
    if (!audioCtxRef.current || !audioBufferRef.current) return;
    stopCurrentSource();

    const source = audioCtxRef.current.createBufferSource();
    source.buffer = audioBufferRef.current;
    source.connect(audioCtxRef.current.destination);
    source.start(0, offset);
    sourceRef.current = source;
    startTimeRef.current = audioCtxRef.current.currentTime;
    startOffsetRef.current = offset;
  }, [stopCurrentSource]);

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
        // Loop back if near end
        if (currentAudioTime >= duration - 0.1) {
          playFrom(beats[0].time);
          updateState({ currentBeat: 0, currentTime: beats[0].time, playedSeconds });
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

  const loadAudio = useCallback(async (file: File, analysisData: AnalysisData) => {
    // Initialize AudioContext on user interaction
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }

    const arrayBuffer = await file.arrayBuffer();
    audioBufferRef.current = await audioCtxRef.current.decodeAudioData(arrayBuffer);

    beatsRef.current = analysisData.beats;
    jumpMapRef.current = buildJumpMap(analysisData.beats, analysisData.edges);
  }, []);

  const play = useCallback(() => {
    if (!audioBufferRef.current || !audioCtxRef.current) return;

    if (audioCtxRef.current.state === "suspended") {
      audioCtxRef.current.resume();
    }

    const offset = startOffsetRef.current;
    playFrom(offset);
    lastLoopContextTimeRef.current = audioCtxRef.current.currentTime;
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

  return {
    loadAudio,
    play,
    pause,
    seek,
    seekToTime,
    reset,
    setJumpSettings,
    playbackState,
    getCurrentAudioTime,
  };
}

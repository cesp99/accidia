import { useCallback, useEffect, useRef, useState } from "react";
import type { store } from "../../wailsjs/go/models";

export type Track = store.Track;

export type RepeatMode = "off" | "all" | "one";

/**
 * A playback "source" is the list the user started playing from — the
 * library, an album, a playlist, a search result. We remember it so
 * shuffle + next/prev have context beyond the manually-queued tracks.
 */
export interface PlaybackSource {
  /** Stable id — "library", "album:<key>", "playlist:<id>", "favorites", "search:<q>". */
  id: string;
  /** Human label used in UI ("Album: Abbey Road", "Library", "Favorites"). */
  label: string;
  tracks: Track[];
}

export interface QueueState {
  current: Track | null;
  source: PlaybackSource | null;
  /** Manually-queued "up next" entries. Consumed front-first. */
  upNext: Track[];
  /** Recently-played tracks (newest-first). Prev() pops from here. */
  history: Track[];
  shuffle: boolean;
  repeat: RepeatMode;
}

const DEFAULT_STATE: QueueState = {
  current: null,
  source: null,
  upNext: [],
  history: [],
  shuffle: false,
  repeat: "off",
};

const STORAGE_KEY = "accidia.queue.v1";

// Only the UI-level preferences are persisted — we don't want to
// resurrect a half-played queue across restarts because the user's idea
// of "what's playing" should match what they last explicitly chose.
interface PersistedPrefs {
  shuffle: boolean;
  repeat: RepeatMode;
}

function loadPrefs(): PersistedPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { shuffle: false, repeat: "off" };
    const parsed = JSON.parse(raw) as Partial<PersistedPrefs>;
    return {
      shuffle: !!parsed.shuffle,
      repeat:
        parsed.repeat === "all" || parsed.repeat === "one" ? parsed.repeat : "off",
    };
  } catch {
    return { shuffle: false, repeat: "off" };
  }
}

function savePrefs(prefs: PersistedPrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage can throw in private-browsing-like modes. Harmless.
  }
}

function indexByPath(tracks: Track[], path: string | undefined): number {
  if (!path) return -1;
  for (let i = 0; i < tracks.length; i++) {
    if (tracks[i].path === path) return i;
  }
  return -1;
}

function pickShuffledNext(
  source: PlaybackSource,
  current: Track | null,
  history: Track[],
): Track | null {
  if (source.tracks.length === 0) return null;
  if (source.tracks.length === 1) return source.tracks[0];

  // Prefer something we haven't played in the recent history + isn't current.
  const recent = new Set<string>();
  if (current) recent.add(current.path);
  for (let i = 0; i < Math.min(history.length, source.tracks.length - 1); i++) {
    recent.add(history[i].path);
  }

  const fresh = source.tracks.filter((t) => !recent.has(t.path));
  const pool = fresh.length > 0 ? fresh : source.tracks.filter((t) => t.path !== current?.path);
  if (pool.length === 0) return source.tracks[0];
  return pool[Math.floor(Math.random() * pool.length)];
}

export interface UseQueueResult {
  state: QueueState;
  /** Play a track from a given source. Clears upNext. */
  playTrack: (track: Track, source: PlaybackSource) => void;
  /** Play a source from its first entry (or a random one when shuffle is on). */
  playSource: (source: PlaybackSource, startAt?: number) => void;
  /** Insert tracks to the *front* of upNext ("Play Next"). */
  playNext: (tracks: Track[]) => void;
  /** Append tracks to the end of upNext ("Add to Queue"). */
  enqueue: (tracks: Track[]) => void;
  /** Advance to the next track, respecting repeat / shuffle / upNext. */
  next: () => Track | null;
  /** Go back one track — pulls from history first, then previous in source. */
  prev: () => Track | null;
  /** Remove an entry from upNext by (index, path) — path tiebreaks when paths repeat. */
  removeFromQueue: (index: number) => void;
  /** Drop the entire manual queue. Source is preserved. */
  clearQueue: () => void;
  /** Peek at the track that would play if the current one ended / skipped. */
  peekNext: () => Track | null;
  setShuffle: (shuffle: boolean) => void;
  toggleShuffle: () => void;
  setRepeat: (repeat: RepeatMode) => void;
  cycleRepeat: () => void;
  /** Reset everything (but not the prefs). */
  reset: () => void;
}

/**
 * useQueue owns the canonical "which track is playing, what's up next,
 * where are we in the source" state. The actual audio engine
 * (`useAudioEngine`) is oblivious to this — we simply call its loadAudio
 * whenever our `current` track changes.
 *
 * Navigation rules (in order):
 *   next()  → shift upNext, else shuffle-pick-next, else next-in-source,
 *             else (repeat=all) wrap to first, else null (stop).
 *   prev()  → pop head of history, push current back to front of upNext.
 */
export function useQueue(): UseQueueResult {
  const initialPrefs = typeof window !== "undefined" ? loadPrefs() : { shuffle: false, repeat: "off" as RepeatMode };
  const [state, setState] = useState<QueueState>({
    ...DEFAULT_STATE,
    shuffle: initialPrefs.shuffle,
    repeat: initialPrefs.repeat,
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  // Persist shuffle/repeat only. The queue itself is session-scoped.
  useEffect(() => {
    savePrefs({ shuffle: state.shuffle, repeat: state.repeat });
  }, [state.shuffle, state.repeat]);

  const playTrack = useCallback((track: Track, source: PlaybackSource) => {
    setState((prev) => ({
      ...prev,
      source,
      // Push the outgoing current onto history (newest-first, capped at 50).
      history: prev.current
        ? [prev.current, ...prev.history.filter((t) => t.path !== prev.current!.path)].slice(0, 50)
        : prev.history,
      current: track,
      // Clear upNext whenever the user explicitly starts a track from a
      // source — upNext is for ad-hoc overrides, not long-term memory.
      upNext: [],
    }));
  }, []);

  const playSource = useCallback((source: PlaybackSource, startAt = 0) => {
    if (source.tracks.length === 0) return;
    const track = stateRef.current.shuffle
      ? source.tracks[Math.floor(Math.random() * source.tracks.length)]
      : source.tracks[Math.max(0, Math.min(startAt, source.tracks.length - 1))];
    if (!track) return;
    playTrack(track, source);
  }, [playTrack]);

  const playNext = useCallback((tracks: Track[]) => {
    if (tracks.length === 0) return;
    setState((prev) => ({
      ...prev,
      upNext: [...tracks, ...prev.upNext],
    }));
  }, []);

  const enqueue = useCallback((tracks: Track[]) => {
    if (tracks.length === 0) return;
    setState((prev) => ({
      ...prev,
      upNext: [...prev.upNext, ...tracks],
    }));
  }, []);

  const peekNext = useCallback((): Track | null => {
    const s = stateRef.current;
    if (s.repeat === "one" && s.current) return s.current;
    if (s.upNext.length > 0) return s.upNext[0];
    const source = s.source;
    if (!source || source.tracks.length === 0) return null;
    if (s.shuffle) {
      return pickShuffledNext(source, s.current, s.history);
    }
    const idx = indexByPath(source.tracks, s.current?.path);
    const nextIdx = idx + 1;
    if (nextIdx < source.tracks.length) return source.tracks[nextIdx];
    if (s.repeat === "all") return source.tracks[0];
    return null;
  }, []);

  const next = useCallback((): Track | null => {
    const s = stateRef.current;
    if (s.repeat === "one" && s.current) {
      // Repeat-one — replay the same track, don't touch history/upNext.
      return s.current;
    }
    let nextTrack: Track | null = null;
    let nextUpNext = s.upNext;
    if (s.upNext.length > 0) {
      nextTrack = s.upNext[0];
      nextUpNext = s.upNext.slice(1);
    } else if (s.source && s.source.tracks.length > 0) {
      if (s.shuffle) {
        nextTrack = pickShuffledNext(s.source, s.current, s.history);
      } else {
        const idx = indexByPath(s.source.tracks, s.current?.path);
        const nextIdx = idx + 1;
        if (nextIdx < s.source.tracks.length) {
          nextTrack = s.source.tracks[nextIdx];
        } else if (s.repeat === "all") {
          nextTrack = s.source.tracks[0];
        }
      }
    }
    if (!nextTrack) {
      setState((prev) => ({ ...prev, upNext: nextUpNext }));
      return null;
    }
    const outgoing = s.current;
    setState((prev) => ({
      ...prev,
      current: nextTrack,
      upNext: nextUpNext,
      history: outgoing
        ? [outgoing, ...prev.history.filter((t) => t.path !== outgoing.path)].slice(0, 50)
        : prev.history,
    }));
    return nextTrack;
  }, []);

  const prev = useCallback((): Track | null => {
    const s = stateRef.current;
    let previousTrack: Track | null = null;
    if (s.history.length > 0) {
      previousTrack = s.history[0];
    } else if (s.source && s.source.tracks.length > 0 && !s.shuffle) {
      // No history yet — fall back to "previous in source".
      const idx = indexByPath(s.source.tracks, s.current?.path);
      if (idx > 0) previousTrack = s.source.tracks[idx - 1];
      else if (s.repeat === "all") previousTrack = s.source.tracks[s.source.tracks.length - 1];
    }
    if (!previousTrack) return null;
    const outgoing = s.current;
    setState((prev) => ({
      ...prev,
      current: previousTrack,
      history: prev.history.slice(1),
      upNext: outgoing ? [outgoing, ...prev.upNext] : prev.upNext,
    }));
    return previousTrack;
  }, []);

  const removeFromQueue = useCallback((index: number) => {
    setState((prev) => {
      if (index < 0 || index >= prev.upNext.length) return prev;
      const next = prev.upNext.slice();
      next.splice(index, 1);
      return { ...prev, upNext: next };
    });
  }, []);

  const clearQueue = useCallback(() => {
    setState((prev) => ({ ...prev, upNext: [] }));
  }, []);

  const setShuffle = useCallback((shuffle: boolean) => {
    setState((prev) => ({ ...prev, shuffle }));
  }, []);

  const toggleShuffle = useCallback(() => {
    setState((prev) => ({ ...prev, shuffle: !prev.shuffle }));
  }, []);

  const setRepeat = useCallback((repeat: RepeatMode) => {
    setState((prev) => ({ ...prev, repeat }));
  }, []);

  const cycleRepeat = useCallback(() => {
    setState((prev) => ({
      ...prev,
      repeat: prev.repeat === "off" ? "all" : prev.repeat === "all" ? "one" : "off",
    }));
  }, []);

  const reset = useCallback(() => {
    setState((prev) => ({
      ...DEFAULT_STATE,
      shuffle: prev.shuffle,
      repeat: prev.repeat,
    }));
  }, []);

  return {
    state,
    playTrack,
    playSource,
    playNext,
    enqueue,
    next,
    prev,
    removeFromQueue,
    clearQueue,
    peekNext,
    setShuffle,
    toggleShuffle,
    setRepeat,
    cycleRepeat,
    reset,
  };
}

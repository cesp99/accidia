import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TitleBar } from "@/components/shell/titlebar";
import { BlurBackground } from "@/components/shell/background";
import { Sidebar, type View } from "@/components/shell/sidebar";
import { PlayerBar } from "@/components/shell/player-bar";
import { NowPlaying } from "@/components/shell/now-playing";
import { LyricsView } from "@/components/shell/lyrics-view";
import { LibraryView } from "@/components/library/library-view";
import { groupByAlbum, groupByArtist } from "@/components/library/library-browsers";
import { FavoritesView, PlaylistView, PlaylistPrompt } from "@/components/library/collection-views";
import {
  getCachedCover,
  loadCover,
  pruneCoverCache,
  prewarmCovers,
} from "@/lib/cover-cache";
import { QueueDrawer } from "@/components/shell/queue-drawer";
import { SettingsView } from "@/components/shell/settings-view";
import { EffectsPanel } from "@/components/jukebox/effects-panel";
import { FFmpegDialog } from "@/components/shell/ffmpeg-dialog";
import { HealthBanner } from "@/components/shell/health-banner";
import {
  useAudioEngine,
  type AnalysisData,
  type JumpSettings,
  type EffectsState,
} from "@/hooks/use-audio-engine";
import { useQueue, type PlaybackSource, type Track } from "@/hooks/use-queue";
import { useFavorites } from "@/hooks/use-favorites";
import { usePlaylists, type Playlist } from "@/hooks/use-playlists";
import { defaultEffectsState } from "@/lib/audio-effects";
import { buildMinimalAnalysis } from "@/lib/audio-analysis";
import { fetchPcm, pcmToAudioBuffer } from "@/lib/pcm";
import {
  CaptureWindowState,
  DecodeTrack,
  GetHostInfo,
  LoadSettings,
  MprisUpdateCapabilities,
  MprisUpdateMetadata,
  MprisUpdatePlaybackStatus,
  MprisUpdatePosition,
  PrefetchTrack,
  SaveUserSettings,
  ShowWindow,
} from "../wailsjs/go/main/App";
import { EventsOn, LogError, LogInfo } from "../wailsjs/runtime/runtime";
import type { audio, main, store } from "../wailsjs/go/models";

interface NowPlayingTrack {
  path: string;
  title: string;
  artist?: string;
  album?: string;
  coverUrl?: string | null;
  analysis: AnalysisData;
  /** The raw Track from the library — handy for favorites/playlist lookups. */
  raw: Track;
}

export default function App() {
  const [platform, setPlatform] = useState<string>("");
  const [appVersion, setAppVersion] = useState<string>("");
  const [view, setView] = useState<View>("library");
  const [track, setTrack] = useState<NowPlayingTrack | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ffmpegPromptFor, setFfmpegPromptFor] = useState<store.Track | null>(null);
  const [jukeboxActive, setJukeboxActive] = useState(false);

  // All known tracks from the library scan, hoisted here so favorites / playlist
  // views can join against them by path.
  const [libraryTracks, setLibraryTracks] = useState<store.Track[]>([]);

  // Album + artist groupings computed once per `libraryTracks` reference.
  // Pulling these up here means switching between Library / Albums /
  // Artists tabs reuses the same buckets — no per-tab `groupBy` pass and
  // (combined with the shared cover cache) no per-tab cover-art IPC fan-out.
  const albumGroups = useMemo(() => groupByAlbum(libraryTracks), [libraryTracks]);
  const artistGroups = useMemo(() => groupByArtist(libraryTracks), [libraryTracks]);

  // Whenever the library changes (initial load, rescan, folder swap)
  // evict cover-art entries for paths that no longer exist and pre-warm
  // the cache for the new set of cover sources. Pre-warming overlaps the
  // IPC fan-out with the user's first interactions instead of stalling
  // the first tab switch on it.
  useEffect(() => {
    if (libraryTracks.length === 0) return;
    const sources: string[] = [];
    const live = new Set<string>();
    for (const g of albumGroups) {
      if (g.artworkSource) {
        sources.push(g.artworkSource);
        live.add(g.artworkSource);
      }
    }
    for (const g of artistGroups) {
      if (g.artworkSource && !live.has(g.artworkSource)) {
        sources.push(g.artworkSource);
        live.add(g.artworkSource);
      }
    }
    // Evict any cached covers whose source path is gone from the new library.
    pruneCoverCache(live);
    // Fire-and-forget — failures are non-fatal, individual hooks will
    // simply re-fetch when mounted.
    prewarmCovers(sources).catch(() => {});
  }, [libraryTracks, albumGroups, artistGroups]);

  // Queue drawer visibility.
  const [queueOpen, setQueueOpen] = useState(false);

  // Playlist create / rename modal state.
  const [playlistPrompt, setPlaylistPrompt] = useState<
    | null
    | {
        mode: "create";
        addTracksAfter?: string[];
      }
    | {
        mode: "rename";
        playlist: Playlist;
      }
  >(null);

  const {
    loadAudio,
    updateAnalysis,
    getContext,
    play,
    pause,
    seek,
    seekToTime,
    setJumpSettings,
    setEffectsState,
    setVolume,
    setShouldLoop,
    setOnTrackEnd,
    playbackState,
    getCurrentAudioTime,
  } = useAudioEngine();

  const queue = useQueue();
  const favorites = useFavorites();
  const playlists = usePlaylists();

  // User-intent jump settings. When jukeboxActive=false we override
  // probability to 0 before handing to the engine, so the slider still
  // reflects the user's chosen value.
  const [jumpSettings, setJumpSettingsState] = useState<JumpSettings>({
    jumpProbability: 0.25,
    minSecondsBetweenJumps: 2,
  });
  const [effectsState, setEffectsStateLocal] = useState<EffectsState>(defaultEffectsState);
  const [volume, setVolumeLocal] = useState(1);
  // backdropOpacity starts as null (unknown) rather than 1.0 so the
  // backdrop component can short-circuit its first render to "blank /
  // transparent" while the persisted value is loading. This is what
  // prevents the startup flash of "fully opaque background → user's
  // chosen translucency" — the window doesn't get shown until the
  // value is in place. See also `settingsApplied` below.
  const [backdropOpacity, setBackdropOpacity] = useState<number | null>(null);

  const settingsLoaded = useRef(false);
  // True once we've applied the persisted settings (or determined
  // there are none). The post-apply effect uses this to call
  // `ShowWindow()` exactly once, revealing the now-correctly-styled
  // window without the user ever seeing the default-state flash.
  const [settingsApplied, setSettingsApplied] = useState(false);

  // Host + settings bootstrap.
  useEffect(() => {
    GetHostInfo()
      .then((h: main.HostInfo) => {
        setPlatform(h.platform);
        if (h.version) setAppVersion(h.version);
      })
      .catch(() => setPlatform("web"));
  }, []);

  useEffect(() => {
    LoadSettings()
      .then((s: store.Settings) => {
        if (s.volume) {
          setVolumeLocal(s.volume);
          setVolume(s.volume);
        }
        if (s.jumpProbability !== undefined && s.jumpCooldown !== undefined) {
          const next = {
            jumpProbability: s.jumpProbability,
            minSecondsBetweenJumps: s.jumpCooldown,
          };
          setJumpSettingsState(next);
        }
        const opacity =
          typeof s.backdropOpacity === "number" && s.backdropOpacity > 0
            ? Math.max(0, Math.min(1, s.backdropOpacity))
            : 1;
        setBackdropOpacity(opacity);
        settingsLoaded.current = true;
        setSettingsApplied(true);
      })
      .catch(() => {
        // Failure path: still resolve to the default opacity so the
        // app is usable, just without persisted preferences.
        setBackdropOpacity(1);
        settingsLoaded.current = true;
        setSettingsApplied(true);
      });
  }, [setVolume]);

  // Reveal the window after the first paint that includes the
  // persisted backdrop opacity. Two-frame requestAnimationFrame so
  // the browser has actually flushed the styles to the GPU before
  // ShowWindow() pops the window in — guards against compositor
  // races where `display: none → block` would otherwise show one
  // frame of stale state.
  const windowRevealed = useRef(false);
  useEffect(() => {
    if (!settingsApplied || windowRevealed.current) return;
    let cancelled = false;
    let r2 = 0;
    const reveal = () => {
      if (cancelled || windowRevealed.current) return;
      windowRevealed.current = true;
      ShowWindow().catch(() => {});
    };
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(reveal);
    });
    // Hidden windows may throttle/skip rAF entirely on some platforms.
    // Fallback so startup doesn't get stuck invisible.
    const fallback = window.setTimeout(reveal, 160);
    return () => {
      cancelled = true;
      cancelAnimationFrame(r1);
      if (r2) cancelAnimationFrame(r2);
      window.clearTimeout(fallback);
    };
  }, [settingsApplied]);

  // Every time the intent or the jukebox toggle changes, re-sync the engine.
  useEffect(() => {
    setJumpSettings({
      jumpProbability: jukeboxActive ? jumpSettings.jumpProbability : 0,
      minSecondsBetweenJumps: jumpSettings.minSecondsBetweenJumps,
    });
  }, [jukeboxActive, jumpSettings, setJumpSettings]);

  // Persist user-controlled settings. Window geometry + libraryRoot
  // are owned by Go (CaptureWindowState / ScanLibrary) so we use the
  // narrow SaveUserSettings binding rather than the legacy
  // SaveSettings, which would otherwise overwrite Go's window state
  // with zeros every time the user touched a slider.
  useEffect(() => {
    if (!settingsLoaded.current || backdropOpacity === null) return;
    SaveUserSettings({
      volume,
      jumpProbability: jumpSettings.jumpProbability,
      jumpCooldown: jumpSettings.minSecondsBetweenJumps,
      backdropOpacity,
      lastTrackPath: track?.path ?? "",
    }).catch(() => {});
  }, [volume, jumpSettings, track?.path, backdropOpacity]);

  // Periodically snapshot the window geometry so a hard crash doesn't
  // lose the user's chosen position. The shutdown hook also captures,
  // but only on a clean exit. We only fire when the window has had
  // time to settle (debounced via the resize listener) and after a
  // user-initiated move (no native event for that on Wails v2, so we
  // poll lazily on focus / page-visibility changes — cheap and good
  // enough).
  useEffect(() => {
    if (!settingsApplied) return;
    let captureTimer: number | undefined;
    const scheduleCapture = () => {
      if (captureTimer !== undefined) window.clearTimeout(captureTimer);
      captureTimer = window.setTimeout(() => {
        CaptureWindowState().catch(() => {});
      }, 800);
    };
    const onResize = () => scheduleCapture();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") scheduleCapture();
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", scheduleCapture);
    return () => {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", scheduleCapture);
      if (captureTimer !== undefined) window.clearTimeout(captureTimer);
    };
  }, [settingsApplied]);

  const handleVolume = useCallback(
    (next: number) => {
      setVolumeLocal(next);
      setVolume(next);
    },
    [setVolume],
  );

  const handleJumpSettings = useCallback(
    (partial: Partial<JumpSettings>) => {
      setJumpSettingsState((prev) => ({ ...prev, ...partial }));
    },
    [],
  );

  const handleEffects = useCallback(
    (next: EffectsState) => {
      setEffectsStateLocal(next);
      setEffectsState(next);
    },
    [setEffectsState],
  );

  // -----------------------------------------------------------------
  // Track loading + playback pipeline
  //
  //   Go:  file → int16 PCM bytes → MediaStore
  //   JS:  fetch /media/<token> → Int16Array
  //        ├─ pcmToAudioBuffer → Web Audio (fast, linear)
  //        └─ (in background) mono Float32 → beat analysis
  //
  // We build the AudioBuffer manually via `createBuffer + copyToChannel`
  // which means we never call `decodeAudioData`. WebKit2GTK's Web Audio
  // decoder has historically refused even well-formed WAV bytes; this
  // path removes that whole class of failure.
  //
  // PROGRESSIVE LOAD: playback starts as soon as the AudioBuffer is ready.
  // Beat detection (the single most expensive step at ~500-1500ms for a
  // 4-minute song) runs in the background and the real analysis replaces
  // the placeholder once it finishes. This cuts perceived track-switch
  // latency roughly in half.
  //
  // After a track starts, we fire a fire-and-forget `PrefetchTrack` for
  // the peek-next track so hitting Next is effectively instant.
  // -----------------------------------------------------------------

  // Guards against a stale load completing after the user has already
  // switched to a different track.
  const loadTokenRef = useRef(0);

  // Convert the Go-side audio.Analysis (or any compatible payload)
  // into the engine's AnalysisData shape. Returns null when the input
  // is missing or doesn't have enough beats to be useful — callers
  // fall back to buildMinimalAnalysis in that case.
  const adoptGoAnalysis = useCallback(
    (raw: audio.Analysis | undefined | null, fallbackTitle: string): AnalysisData | null => {
      if (!raw) return null;
      if (!raw.beats || raw.beats.length === 0) return null;
      return {
        title: raw.title || fallbackTitle,
        bpm: raw.bpm,
        duration: raw.duration,
        n_beats: raw.n_beats,
        beats: raw.beats.map((b) => ({ index: b.index, time: b.time })),
        edges: (raw.edges ?? []).map((e) => ({
          from: e.from,
          to: e.to,
          similarity: e.similarity,
        })),
      };
    },
    [],
  );

  const loadAndPlayTrack = useCallback(
    async (t: store.Track): Promise<boolean> => {
      setError(null);
      const token = ++loadTokenRef.current;

      let phase: "decode" | "fetch" | "playback" = "decode";
      try {
        // Cover art runs alongside decoding. We don't await it up
        // front because GetCoverArt re-reads the file's tag chunk —
        // for prefetched (cache-hit) DecodeTrack calls the cover IPC
        // can dominate the hot path. Instead we kick it off and let
        // the result land asynchronously, updating the track view
        // when it arrives.
        //
        // Synchronous cache hit is preferred so we paint the right
        // cover from frame one (replays + tracks whose art was
        // pre-warmed by the library tab). Misses paint with no cover
        // for one frame and patch in once `loadCover` resolves.
        const cachedCover = t.hasCoverArt ? getCachedCover(t.path) : null;
        const coverPromise: Promise<string | null> = t.hasCoverArt
          ? loadCover(t.path)
          : Promise.resolve(null);
        const decoded = await DecodeTrack(t.path);
        if (token !== loadTokenRef.current) return false;
        if (!decoded.mediaUrl) {
          throw new Error("Go decoder returned no media URL");
        }

        phase = "fetch";
        const pcm = await fetchPcm(decoded.mediaUrl);
        if (token !== loadTokenRef.current) return false;

        phase = "playback";
        const displayTitle = decoded.title || t.title;
        const ctx = getContext();
        const audioBuffer = pcmToAudioBuffer(
          ctx,
          pcm,
          decoded.sampleRate,
          decoded.channels,
          decoded.frames,
        );
        // Beat analysis is now computed in Go (off the main thread)
        // and disk-cached by file (path, mtime). DecodeTrack returns
        // the result inline so the frontend just consumes it. We
        // still keep buildMinimalAnalysis as a defensive fallback
        // for tracks where Go couldn't find a usable beat grid
        // (very short clips, dead silence, etc.).
        const goAnalysis = adoptGoAnalysis(decoded.analysis, displayTitle);
        const initialAnalysis =
          goAnalysis ?? buildMinimalAnalysis(decoded.duration, displayTitle);
        await loadAudio(audioBuffer, initialAnalysis);

        const effectiveTitle = t.title || displayTitle;
        const effectiveArtist = decoded.artist || t.artist || "";
        const effectiveAlbum = decoded.album || t.album || "";

        setTrack({
          path: t.path,
          title: effectiveTitle,
          // If we already had art cached from the library view, paint
          // with it so there's no flicker. Cache misses fall through
          // to the async patch below.
          coverUrl: cachedCover ?? null,
          artist: effectiveArtist,
          album: effectiveAlbum,
          analysis: {
            ...initialAnalysis,
            title: effectiveTitle,
          },
          raw: t,
        });

        setEffectsState(effectsState);
        setVolume(volume);
        play();

        // The "analyzing…" indicator was used to flag the period
        // between play start and the heavy JS pass finishing. With
        // analysis now coming inline from Go (or arriving cached
        // from disk) there's never that gap, so we always settle on
        // false here.
        setAnalyzing(false);

        // Resolve the cover and patch the track in place once it's
        // ready. No-op when cachedCover already matches.
        coverPromise.then((cover) => {
          if (token !== loadTokenRef.current) return;
          if (!cover) return;
          setTrack((prev) =>
            prev && prev.path === t.path && prev.coverUrl !== cover
              ? { ...prev, coverUrl: cover }
              : prev,
          );
        });

        return true;
      } catch (e) {
        const msg = formatError(e);
        if (msg.startsWith("ffmpeg-required")) {
          setFfmpegPromptFor(t);
        } else {
          console.error(`[${phase}]`, e);
          setError(`${phase}: ${msg}`);
        }
        if (token === loadTokenRef.current) setAnalyzing(false);
        return false;
      }
    },
    [
      loadAudio,
      getContext,
      play,
      setEffectsState,
      setVolume,
      effectsState,
      volume,
      adoptGoAnalysis,
    ],
  );

  // Prefetch the "next" track in the background so hitting Next is instant.
  // We only start the prefetch once the current track has been loaded and
  // the user's been playing for ~1s — no point decoding while the initial
  // load is already stressing the system.
  const prefetchedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!track) return;
    if (prefetchedForRef.current === track.path) return;
    const timeout = setTimeout(() => {
      const upcoming = queue.peekNext();
      if (!upcoming || upcoming.path === track.path) return;
      prefetchedForRef.current = track.path;
      PrefetchTrack(upcoming.path).catch(() => {
        // Prefetch failures are non-fatal — the full load will happen
        // when the user actually triggers Next.
      });
    }, 800);
    return () => clearTimeout(timeout);
  }, [track, queue]);

  // -----------------------------------------------------------------
  // Queue glue — whenever queue.state.current changes, actually load it.
  // -----------------------------------------------------------------
  const lastLoadedRef = useRef<string | null>(null);
  useEffect(() => {
    const t = queue.state.current;
    if (!t) return;
    if (lastLoadedRef.current === t.path && track?.path === t.path) return;
    lastLoadedRef.current = t.path;
    loadAndPlayTrack(t);
  }, [queue.state.current, loadAndPlayTrack, track?.path]);

  // Track-end handling — driven by the engine's onTrackEnd callback
  // (single fire per track, no more polling-interval race conditions).
  //
  // Modes:
  //   jukeboxActive           → engine auto-loops (jumps dominate, but
  //                             if no jump lands at the end we loop
  //                             rather than pause)
  //   repeat === "one"        → engine auto-loops (single-track repeat)
  //   otherwise               → engine fires onTrackEnd:
  //                               - if Up Next has entries, consume one
  //                               - if shuffle is on, advance to a random
  //                                 next track from the active source
  //                               - otherwise pause
  //
  // We use refs for `queue.next` + `pause` so the effect body can be
  // stable and the callback registered on the engine doesn't churn
  // every render (useQueue returns a fresh object literal each tick).
  const queueNextRef = useRef(queue.next);
  const pauseRef = useRef(pause);
  useEffect(() => {
    queueNextRef.current = queue.next;
    pauseRef.current = pause;
  });

  useEffect(() => {
    const shouldLoop = jukeboxActive || queue.state.repeat === "one";
    const hasQueuedNext = queue.state.upNext.length > 0;
    const shouldAdvanceOnEnd = hasQueuedNext || queue.state.shuffle;
    setShouldLoop(shouldLoop);
    if (shouldLoop) {
      setOnTrackEnd(null);
    } else {
      setOnTrackEnd(() => {
        if (shouldAdvanceOnEnd) {
          queueNextRef.current();
          return;
        }
        pauseRef.current();
      });
    }
    return () => setOnTrackEnd(null);
  }, [jukeboxActive, queue.state.repeat, queue.state.shuffle, queue.state.upNext.length, setShouldLoop, setOnTrackEnd]);

  const handlePlayPause = useCallback(() => {
    if (!track) return;
    if (playbackState.isPlaying) pause();
    else play();
  }, [playbackState.isPlaying, play, pause, track]);

  // -----------------------------------------------------------------
  // Play actions from UI — all flow through the queue, which drives
  // the loadAndPlayTrack effect above.
  // -----------------------------------------------------------------

  const playTrackFromList = useCallback(
    (t: store.Track, tracks: store.Track[], label: string, sourceId = `list:${label}`) => {
      if (tracks.length === 0) return;
      if (view !== "now-playing") setView("now-playing");
      queue.playTrack(t, { id: sourceId, label, tracks });
    },
    [queue, view],
  );

  const shufflePlayTracks = useCallback(
    (tracks: store.Track[], label: string) => {
      if (tracks.length === 0) return;
      const source: PlaybackSource = { id: `list:${label}:shuffle`, label, tracks };
      queue.setShuffle(true);
      if (view !== "now-playing") setView("now-playing");
      queue.playSource(source);
    },
    [queue, view],
  );

  const handlePlayNext = useCallback(
    (tracks: store.Track[]) => {
      queue.playNext(tracks);
      setQueueOpen(true);
    },
    [queue],
  );

  const handleAddToQueue = useCallback(
    (tracks: store.Track[]) => {
      queue.enqueue(tracks);
      setQueueOpen(true);
    },
    [queue],
  );

  const handleNextButton = useCallback(() => {
    // If there's nothing to advance to, do nothing.
    queue.next();
  }, [queue]);

  const handlePrevButton = useCallback(() => {
    // "Previous" convention: if we're more than 3 seconds into the track,
    // restart the current one; otherwise jump to history head.
    if (track && getCurrentAudioTime() > 3) {
      seekToTime(0);
      return;
    }
    queue.prev();
  }, [queue, track, seekToTime, getCurrentAudioTime]);

  // -----------------------------------------------------------------
  // Media Session API — OS integration
  //
  // Publishes the current track's metadata + playback state to the host
  // OS so:
  //   - Keyboard media keys (play/pause/next/prev) work
  //   - Desktop widgets (KDE panel, GNOME media indicator, Windows SMTC,
  //     macOS Now Playing) show what's playing
  //   - Headset / Bluetooth transport controls map to our actions
  //
  // WebKit2GTK bridges the Web MediaSession API to MPRIS since 2.42;
  // Chromium (Windows/Linux) bridges to SMTC / MPRIS; Safari (macOS)
  // bridges to Now Playing. No platform-specific code needed here.
  // -----------------------------------------------------------------

  // Stable refs so the media-session handlers see the latest actions
  // without us having to re-register them every frame.
  const handlePrevRef = useRef(handlePrevButton);
  const handleNextRef = useRef(handleNextButton);
  useEffect(() => {
    handlePrevRef.current = handlePrevButton;
    handleNextRef.current = handleNextButton;
  });

  // Register the action handlers once on mount — they proxy through
  // the refs above. Unregister on unmount so stale closures don't leak.
  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms) return;
    const register = (
      action: MediaSessionAction,
      handler: MediaSessionActionHandler | null,
    ) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* not all actions are supported on every platform */
      }
    };
    register("play", () => play());
    register("pause", () => pause());
    register("previoustrack", () => handlePrevRef.current());
    register("nexttrack", () => handleNextRef.current());
    register("seekto", (details) => {
      if (typeof details.seekTime === "number") seekToTime(details.seekTime);
    });
    register("seekbackward", (details) => {
      const delta = details.seekOffset ?? 10;
      seekToTime(Math.max(0, getCurrentAudioTime() - delta));
    });
    register("seekforward", (details) => {
      const delta = details.seekOffset ?? 10;
      seekToTime(getCurrentAudioTime() + delta);
    });
    register("stop", () => pause());
    return () => {
      for (const a of [
        "play",
        "pause",
        "previoustrack",
        "nexttrack",
        "seekto",
        "seekbackward",
        "seekforward",
        "stop",
      ] as MediaSessionAction[]) {
        register(a, null);
      }
    };
  }, [play, pause, seekToTime, getCurrentAudioTime]);

  // Update metadata whenever the track (or its cover) changes.
  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms) return;
    if (!track) {
      ms.metadata = null;
      ms.playbackState = "none";
      return;
    }
    const artwork: MediaImage[] = track.coverUrl
      ? [
          // Most platforms just take the first entry; we claim a big
          // size hint so SMTC / MPRIS don't under-scale it.
          { src: track.coverUrl, sizes: "512x512", type: "image/jpeg" },
        ]
      : [];
    try {
      ms.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist || "",
        album: track.album || "",
        artwork,
      });
    } catch {
      /* very old WebKit builds may lack MediaMetadata */
    }
  }, [track]);

  // Keep playbackState + position state in sync. setPositionState lets
  // the OS scrub/seek through the media widget.
  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms) return;
    ms.playbackState = playbackState.isPlaying ? "playing" : "paused";
    const duration = track?.analysis.duration ?? 0;
    if (duration > 0 && typeof ms.setPositionState === "function") {
      try {
        ms.setPositionState({
          duration,
          playbackRate: 1,
          position: Math.max(0, Math.min(duration, playbackState.currentTime)),
        });
      } catch {
        /* some WebViews throw on rapid updates — non-fatal */
      }
    }
  }, [playbackState.isPlaying, playbackState.currentTime, track?.analysis.duration]);

  // -----------------------------------------------------------------
  // MPRIS bridge — the real media-key handler on Linux.
  //
  // WebKit2GTK does not bridge the Web MediaSession API to MPRIS for
  // Web Audio-only playback (only for HTMLMediaElement). So on Linux
  // we publish our own MPRIS service directly from Go (see
  // internal/mpris). The frontend's job is just to keep Go's state in
  // sync and to route incoming desktop commands back to our handlers.
  //
  // On macOS / Windows the Go MPRIS controller is a stub, so these
  // calls are cheap no-ops — the Media Session block above covers
  // SMTC + Now Playing there.
  // -----------------------------------------------------------------

  // Push track metadata to Go whenever the song changes.
  useEffect(() => {
    if (!track) {
      LogInfo("[mpris] clearing metadata (no track)");
      MprisUpdateMetadata("", "", "", "", "", 0).catch((e) => {
        const msg = `[mpris] metadata clear failed: ${e}`;
        console.warn(msg);
        LogError(msg);
      });
      return;
    }
    LogInfo(
      `[mpris] pushing metadata title=${track.title} artist=${track.artist || ""} dur=${track.analysis.duration}`,
    );
    MprisUpdateMetadata(
      track.title,
      track.artist || "",
      track.album || "",
      track.coverUrl || "",
      track.path,
      track.analysis.duration,
    ).catch((e) => {
      const msg = `[mpris] metadata push failed: ${e}`;
      console.warn(msg);
      LogError(msg);
    });
  }, [track]);

  // Push playback status.
  useEffect(() => {
    const status = !track ? "Stopped" : playbackState.isPlaying ? "Playing" : "Paused";
    LogInfo(`[mpris] pushing status=${status}`);
    MprisUpdatePlaybackStatus(status).catch((e) => {
      const msg = `[mpris] playback status push failed: ${e}`;
      console.warn(msg);
      LogError(msg);
    });
  }, [track, playbackState.isPlaying]);

  // Push scrubber position. playbackState.currentTime updates at ~60 Hz
  // which would be very chatty over D-Bus; throttle to ~2 Hz since the
  // desktop widget polls at ~1 Hz anyway.
  const lastMprisPosPushRef = useRef(0);
  useEffect(() => {
    const now = Date.now();
    if (now - lastMprisPosPushRef.current < 500) return;
    lastMprisPosPushRef.current = now;
    MprisUpdatePosition(playbackState.currentTime).catch((e) =>
      console.warn("[mpris] position push failed:", e),
    );
  }, [playbackState.currentTime]);

  // Push navigation capabilities so the desktop widget greys out
  // Previous/Next correctly when there's nothing to go to.
  const canNext = queue.peekNext() !== null;
  const canPrev =
    queue.state.history.length > 0 ||
    (!queue.state.shuffle &&
      !!queue.state.source &&
      queue.state.source.tracks.findIndex(
        (t) => t.path === queue.state.current?.path,
      ) > 0) ||
    queue.state.repeat === "all";
  useEffect(() => {
    MprisUpdateCapabilities(canNext, canPrev).catch((e) =>
      console.warn("[mpris] capabilities push failed:", e),
    );
  }, [canNext, canPrev]);

  // Stable refs so the subscribers below see fresh values without
  // having to re-subscribe on every render (Wails event subscriptions
  // don't cost a lot, but re-subscribing every tick is noisy).
  const mprisPlayRef = useRef<() => void>(() => play());
  const mprisPauseRef = useRef<() => void>(() => pause());
  const mprisPlayPauseRef = useRef<() => void>(() => {});
  const mprisNextRef = useRef<() => void>(() => {});
  const mprisPrevRef = useRef<() => void>(() => {});
  const mprisSeekRef = useRef<(offset: number) => void>(() => {});
  const mprisSetPositionRef = useRef<(pos: number) => void>(() => {});
  useEffect(() => {
    mprisPlayRef.current = () => play();
    mprisPauseRef.current = () => pause();
    mprisPlayPauseRef.current = () => {
      if (playbackState.isPlaying) pause();
      else if (track) play();
    };
    mprisNextRef.current = handleNextButton;
    mprisPrevRef.current = handlePrevButton;
    mprisSeekRef.current = (offset: number) => {
      const next = Math.max(0, getCurrentAudioTime() + offset);
      seekToTime(next);
    };
    mprisSetPositionRef.current = (pos: number) => seekToTime(Math.max(0, pos));
  });

  // Subscribe once to every mpris:* Wails event. The runtime's
  // EventsOn returns an unsubscribe function which we return from the
  // effect so React tears it down cleanly on unmount.
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    unsubs.push(EventsOn("mpris:play", () => mprisPlayRef.current()));
    unsubs.push(EventsOn("mpris:pause", () => mprisPauseRef.current()));
    unsubs.push(EventsOn("mpris:playpause", () => mprisPlayPauseRef.current()));
    unsubs.push(EventsOn("mpris:stop", () => mprisPauseRef.current()));
    unsubs.push(EventsOn("mpris:next", () => mprisNextRef.current()));
    unsubs.push(EventsOn("mpris:previous", () => mprisPrevRef.current()));
    unsubs.push(
      EventsOn("mpris:seek", (...args: unknown[]) => {
        const offset = typeof args[0] === "number" ? args[0] : 0;
        mprisSeekRef.current(offset);
      }),
    );
    unsubs.push(
      EventsOn("mpris:setposition", (...args: unknown[]) => {
        const pos = typeof args[0] === "number" ? args[0] : 0;
        mprisSetPositionRef.current(pos);
      }),
    );
    return () => {
      for (const u of unsubs) u();
    };
  }, []);

  // -----------------------------------------------------------------
  // Favorites + Playlists wiring
  // -----------------------------------------------------------------

  const isCurrentFavorite = track ? favorites.isFavorite(track.path) : false;

  const handleToggleCurrentFavorite = useCallback(() => {
    if (!track) return;
    favorites.toggleFavorite(track.path).catch((e) => setError(String(e)));
  }, [favorites, track]);

  const handleToggleFavorite = useCallback(
    (path: string) => {
      favorites.toggleFavorite(path).catch((e) => setError(String(e)));
    },
    [favorites],
  );

  const handleAddToPlaylist = useCallback(
    async (playlistId: string, paths: string[]) => {
      try {
        await playlists.add(playlistId, paths);
      } catch (e) {
        setError(String(e));
      }
    },
    [playlists],
  );

  const handleCreatePlaylistWithTracks = useCallback((paths: string[]) => {
    setPlaylistPrompt({ mode: "create", addTracksAfter: paths });
  }, []);

  const handleNewPlaylist = useCallback(() => {
    setPlaylistPrompt({ mode: "create" });
  }, []);

  const handleRenamePlaylist = useCallback((pl: Playlist) => {
    setPlaylistPrompt({ mode: "rename", playlist: pl });
  }, []);

  const handleDeletePlaylist = useCallback(
    async (pl: Playlist) => {
      const confirmed = window.confirm(`Delete playlist “${pl.name}”?`);
      if (!confirmed) return;
      try {
        await playlists.remove(pl.id);
        setView((v) =>
          typeof v === "object" && v.type === "playlist" && v.id === pl.id ? "library" : v,
        );
      } catch (e) {
        setError(String(e));
      }
    },
    [playlists],
  );

  const submitPlaylistPrompt = useCallback(
    async (name: string, description: string) => {
      if (!playlistPrompt) return;
      if (playlistPrompt.mode === "create") {
        const pl = await playlists.create(name, description);
        if (playlistPrompt.addTracksAfter?.length) {
          await playlists.add(pl.id, playlistPrompt.addTracksAfter);
        }
        setView({ type: "playlist", id: pl.id });
      } else {
        await playlists.rename(playlistPrompt.playlist.id, name, description);
      }
    },
    [playlistPrompt, playlists],
  );

  const handleRemoveFromCurrentPlaylist = useCallback(
    async (paths: string[], playlistId: string) => {
      try {
        await playlists.removeTracks(playlistId, paths);
      } catch (e) {
        setError(String(e));
      }
    },
    [playlists],
  );

  // Called by FFmpegDialog when the install succeeds — replay the track
  // the user originally tried to play.
  const handleFFmpegInstalled = useCallback(() => {
    const t = ffmpegPromptFor;
    setFfmpegPromptFor(null);
    if (t) loadAndPlayTrack(t);
  }, [ffmpegPromptFor, loadAndPlayTrack]);

  // -----------------------------------------------------------------
  // Coming-up preview for the queue drawer — show the next few tracks
  // from the source that aren't manually queued.
  // -----------------------------------------------------------------
  const comingUp = useMemo(() => {
    const s = queue.state.source;
    if (!s || !queue.state.current) return [];
    const idx = s.tracks.findIndex((t) => t.path === queue.state.current!.path);
    if (idx < 0) return [];
    return s.tracks.slice(idx + 1, idx + 6);
  }, [queue.state.source, queue.state.current]);

  const hasPrev = queue.state.history.length > 0 || (() => {
    const s = queue.state.source;
    if (!s || queue.state.shuffle) return false;
    const idx = s.tracks.findIndex((t) => t.path === queue.state.current?.path);
    return idx > 0 || queue.state.repeat === "all";
  })();
  const hasNext = queue.peekNext() !== null;

  // Resolve the current playlist if we're on a playlist view.
  const currentPlaylist = useMemo(() => {
    if (typeof view !== "object" || view.type !== "playlist") return null;
    return playlists.playlists.find((p) => p.id === view.id) ?? null;
  }, [view, playlists.playlists]);

  // If the user deletes the currently-viewed playlist from another path,
  // fall back to library.
  useEffect(() => {
    if (typeof view === "object" && view.type === "playlist" && playlists.loaded) {
      if (!playlists.playlists.some((p) => p.id === view.id)) {
        setView("library");
      }
    }
  }, [view, playlists.playlists, playlists.loaded]);

  const mainView = useMemo(() => {
    if (typeof view === "object" && view.type === "playlist") {
      if (!currentPlaylist) {
        return (
          <div className="flex h-full items-center justify-center px-10 text-sm text-muted-foreground">
            Playlist not found.
          </div>
        );
      }
      return (
        <PlaylistView
          allTracks={libraryTracks}
          playlist={currentPlaylist}
          currentPath={track?.path}
          onPlay={(t, tracks, label) => playTrackFromList(t, tracks, label, `playlist:${currentPlaylist.id}`)}
          onShufflePlay={(tracks, label) => shufflePlayTracks(tracks, label)}
          onPlayNext={handlePlayNext}
          onAddToQueue={handleAddToQueue}
          isFavorite={favorites.isFavorite}
          onToggleFavorite={handleToggleFavorite}
          playlists={playlists.playlists}
          onAddToPlaylist={handleAddToPlaylist}
          onCreatePlaylistWithTracks={handleCreatePlaylistWithTracks}
          onRemoveFromPlaylist={(paths) =>
            handleRemoveFromCurrentPlaylist(paths, currentPlaylist.id)
          }
        />
      );
    }

    switch (view) {
      case "favorites":
        return (
          <FavoritesView
            allTracks={libraryTracks}
            favoritePaths={favorites.paths}
            currentPath={track?.path}
            onPlay={(t, tracks) => playTrackFromList(t, tracks, "Favorites", "favorites")}
            onShufflePlay={(tracks) => shufflePlayTracks(tracks, "Favorites")}
            onPlayNext={handlePlayNext}
            onAddToQueue={handleAddToQueue}
            isFavorite={favorites.isFavorite}
            onToggleFavorite={handleToggleFavorite}
            playlists={playlists.playlists}
            onAddToPlaylist={handleAddToPlaylist}
            onCreatePlaylistWithTracks={handleCreatePlaylistWithTracks}
          />
        );
      case "now-playing":
        return (
          <NowPlaying
            title={track?.title}
            artist={track?.artist}
            album={track?.album}
            coverUrl={track?.coverUrl}
            analysis={track?.analysis ?? null}
            playback={playbackState}
            isAnalyzing={analyzing}
            onSeekBeat={seek}
            jumpSettings={jumpSettings}
            onJumpSettingsChange={handleJumpSettings}
            jukeboxActive={jukeboxActive}
            onToggleJukebox={() => setJukeboxActive((v) => !v)}
          />
        );
      case "lyrics":
        return (
          <LyricsView
            title={track?.title}
            artist={track?.artist}
            album={track?.album}
            duration={track?.analysis.duration}
            coverUrl={track?.coverUrl}
            currentTime={playbackState.currentTime}
            isPlaying={playbackState.isPlaying}
            onSeek={seekToTime}
          />
        );
      case "effects":
        return (
          <div className="h-full overflow-y-auto scroll-thin px-8 py-6">
            <EffectsPanel state={effectsState} onChange={handleEffects} />
          </div>
        );
      case "settings":
        return (
          <SettingsView
            backdropOpacity={backdropOpacity}
            onBackdropOpacityChange={setBackdropOpacity}
            version={appVersion}
          />
        );
      case "library":
      default:
        return (
          <LibraryView
            currentPath={track?.path}
            onPlay={playTrackFromList}
            onShufflePlay={shufflePlayTracks}
            onPlayNext={handlePlayNext}
            onAddToQueue={handleAddToQueue}
            isFavorite={favorites.isFavorite}
            onToggleFavorite={handleToggleFavorite}
            playlists={playlists.playlists}
            onAddToPlaylist={handleAddToPlaylist}
            onCreatePlaylistWithTracks={handleCreatePlaylistWithTracks}
            onLibraryLoad={(lib) => setLibraryTracks(lib.tracks)}
            albumGroups={albumGroups}
            artistGroups={artistGroups}
          />
        );
    }
  }, [
    view,
    track,
    playbackState,
    analyzing,
    seek,
    seekToTime,
    jumpSettings,
    handleJumpSettings,
    jukeboxActive,
    effectsState,
    handleEffects,
    playTrackFromList,
    shufflePlayTracks,
    handlePlayNext,
    handleAddToQueue,
    favorites.isFavorite,
    favorites.paths,
    handleToggleFavorite,
    playlists.playlists,
    handleAddToPlaylist,
    handleCreatePlaylistWithTracks,
    handleRemoveFromCurrentPlaylist,
    libraryTracks,
    albumGroups,
    artistGroups,
    currentPlaylist,
    backdropOpacity,
    appVersion,
  ]);

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      <BlurBackground
        coverUrl={track?.coverUrl}
        isPlaying={playbackState.isPlaying}
        backdropOpacity={backdropOpacity}
      />

      <TitleBar platform={platform} />

      <HealthBanner />

      {error && (
        <div
          role="alert"
          className="z-20 mx-auto mt-2 flex max-w-2xl items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/15 px-3 py-2 text-xs text-destructive-foreground backdrop-blur"
        >
          <span className="min-w-0 flex-1 break-words font-mono">{error}</span>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(error).catch(() => {});
            }}
            className="shrink-0 rounded border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[10px] uppercase tracking-wider hover:bg-destructive/20"
          >
            Copy
          </button>
          <button
            type="button"
            onClick={() => setError(null)}
            className="shrink-0 rounded border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[10px] uppercase tracking-wider hover:bg-destructive/20"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="relative z-10 flex min-h-0 flex-1">
        <Sidebar
          view={view}
          onChange={setView}
          isPlaying={playbackState.isPlaying}
          jukeboxActive={jukeboxActive}
          onToggleJukebox={() => setJukeboxActive((v) => !v)}
          favoritesCount={favorites.paths.length}
          playlists={playlists.playlists}
          onNewPlaylist={handleNewPlaylist}
          onRenamePlaylist={handleRenamePlaylist}
          onDeletePlaylist={handleDeletePlaylist}
        />
        <main className="relative min-h-0 flex-1 overflow-hidden">
          {mainView}
          <QueueDrawer
            open={queueOpen}
            onClose={() => setQueueOpen(false)}
            current={queue.state.current}
            currentCover={track?.coverUrl ?? null}
            upNext={queue.state.upNext}
            comingUp={comingUp}
            onRemove={queue.removeFromQueue}
            onClear={queue.clearQueue}
            onPlayIndex={(t) => {
              // When clicking something in "Up Next", we reuse the current
              // source so "next/prev" semantics keep working naturally.
              const source =
                queue.state.source ?? {
                  id: "queue",
                  label: "Queue",
                  tracks: [t],
                };
              queue.playTrack(t, source);
            }}
            onJumpToSourceTrack={(t) => {
              const source = queue.state.source ?? null;
              if (source) queue.playTrack(t, source);
            }}
          />
        </main>
      </div>

      <PlayerBar
        title={track?.title}
        artist={track?.artist}
        coverUrl={track?.coverUrl}
        isPlaying={playbackState.isPlaying}
        onPlayPause={handlePlayPause}
        duration={track?.analysis.duration ?? 0}
        currentTime={playbackState.currentTime}
        onSeek={seekToTime}
        volume={volume}
        onVolume={handleVolume}
        jumpCount={playbackState.jumpCount}
        bpm={track?.analysis.bpm}
        onOpenNowPlaying={() => setView("now-playing")}
        hasTrack={!!track}
        jukeboxActive={jukeboxActive}
        onNext={handleNextButton}
        onPrev={handlePrevButton}
        hasNext={hasNext}
        hasPrev={hasPrev}
        shuffle={queue.state.shuffle}
        onToggleShuffle={queue.toggleShuffle}
        repeat={queue.state.repeat}
        onCycleRepeat={queue.cycleRepeat}
        isFavorite={isCurrentFavorite}
        onToggleFavorite={handleToggleCurrentFavorite}
        onToggleQueue={() => setQueueOpen((v) => !v)}
        queueOpen={queueOpen}
        upNextCount={queue.state.upNext.length}
      />

      <FFmpegDialog
        open={!!ffmpegPromptFor}
        trackName={ffmpegPromptFor?.title ?? "this track"}
        onCancel={() => setFfmpegPromptFor(null)}
        onInstalled={handleFFmpegInstalled}
      />

      <PlaylistPrompt
        open={!!playlistPrompt}
        title={playlistPrompt?.mode === "rename" ? "Rename playlist" : "New playlist"}
        initialName={playlistPrompt?.mode === "rename" ? playlistPrompt.playlist.name : ""}
        initialDescription={
          playlistPrompt?.mode === "rename" ? playlistPrompt.playlist.description ?? "" : ""
        }
        confirmLabel={playlistPrompt?.mode === "rename" ? "Save" : "Create"}
        onClose={() => setPlaylistPrompt(null)}
        onSubmit={submitPlaylistPrompt}
      />
    </div>
  );
}

function formatError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

/**
 * Schedule `fn` to run when the browser is idle, with a 1.5s timeout
 * as a safety net if the page stays busy. Falls back to setTimeout
 * when requestIdleCallback isn't available (older WebKit builds).
 */
function scheduleIdle(fn: () => void) {
  const win = window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  };
  if (typeof win.requestIdleCallback === "function") {
    win.requestIdleCallback(fn, { timeout: 1500 });
  } else {
    window.setTimeout(fn, 50);
  }
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TitleBar } from "@/components/shell/titlebar";
import { BlurBackground } from "@/components/shell/background";
import { Sidebar, type View } from "@/components/shell/sidebar";
import { PlayerBar } from "@/components/shell/player-bar";
import { NowPlaying } from "@/components/shell/now-playing";
import { LyricsView } from "@/components/shell/lyrics-view";
import { LibraryView } from "@/components/library/library-view";
import { FavoritesView, PlaylistView, PlaylistPrompt } from "@/components/library/collection-views";
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
import { analyzeMonoPcm, buildMinimalAnalysis } from "@/lib/audio-analysis";
import { fetchPcm, pcmToAudioBuffer, pcmToMonoFloat32 } from "@/lib/pcm";
import {
  DecodeTrack,
  GetCoverArt,
  GetHostInfo,
  LoadSettings,
  MprisUpdateCapabilities,
  MprisUpdateMetadata,
  MprisUpdatePlaybackStatus,
  MprisUpdatePosition,
  PrefetchTrack,
  SaveSettings,
} from "../wailsjs/go/main/App";
import { EventsOn, LogError, LogInfo } from "../wailsjs/runtime/runtime";
import type { main, store } from "../wailsjs/go/models";

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
  const [backdropOpacity, setBackdropOpacity] = useState(1);

  const settingsLoaded = useRef(false);

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
        if (typeof s.backdropOpacity === "number" && s.backdropOpacity > 0) {
          setBackdropOpacity(Math.max(0, Math.min(1, s.backdropOpacity)));
        }
        settingsLoaded.current = true;
      })
      .catch(() => {
        settingsLoaded.current = true;
      });
  }, [setVolume]);

  // Every time the intent or the jukebox toggle changes, re-sync the engine.
  useEffect(() => {
    setJumpSettings({
      jumpProbability: jukeboxActive ? jumpSettings.jumpProbability : 0,
      minSecondsBetweenJumps: jumpSettings.minSecondsBetweenJumps,
    });
  }, [jukeboxActive, jumpSettings, setJumpSettings]);

  // Persist settings.
  useEffect(() => {
    if (!settingsLoaded.current) return;
    SaveSettings({
      volume,
      jumpProbability: jumpSettings.jumpProbability,
      jumpCooldown: jumpSettings.minSecondsBetweenJumps,
      libraryRoot: "",
      lastTrackPath: track?.path ?? "",
      windowWidth: 0,
      windowHeight: 0,
      backdropOpacity,
    } as store.Settings).catch(() => {});
  }, [volume, jumpSettings, track?.path, backdropOpacity]);

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

  // Guards against a stale analysis finishing after the user has
  // already switched to a different track.
  const loadTokenRef = useRef(0);

  // Deferred analysis input for the *current* track. Populated on load,
  // cleared after the heavy analysis runs (or on track change). We store
  // just what analyzeMonoPcm needs: the mono float buffer + metadata.
  // Beat analysis on a 4-minute song is ~500-1500ms on the main thread,
  // so we only run it when Infinite Jukebox is actually on — otherwise
  // track switching is faster and the user never pays for a feature
  // they don't use.
  const pendingAnalysisRef = useRef<{
    trackPath: string;
    token: number;
    mono: Float32Array;
    sampleRate: number;
    duration: number;
    displayTitle: string;
  } | null>(null);

  // Runs the heavy analyzeMonoPcm pass on whatever is in
  // pendingAnalysisRef and swaps the result into the audio engine. No-op
  // if nothing is pending (already analysed / different track).
  const runAnalysisNow = useCallback(() => {
    const p = pendingAnalysisRef.current;
    if (!p) return;
    if (p.token !== loadTokenRef.current) {
      pendingAnalysisRef.current = null;
      return;
    }
    try {
      const real = analyzeMonoPcm(p.mono, p.sampleRate, p.duration, p.displayTitle);
      if (p.token !== loadTokenRef.current) return;
      updateAnalysis(real);
      setTrack((prev) =>
        prev && prev.path === p.trackPath
          ? { ...prev, analysis: { ...real, title: prev.title } }
          : prev,
      );
    } catch (e) {
      console.warn("[analyze]", e);
    } finally {
      // Free the mono buffer regardless — we don't re-analyze.
      pendingAnalysisRef.current = null;
      setAnalyzing(false);
    }
  }, [updateAnalysis]);

  const loadAndPlayTrack = useCallback(
    async (t: store.Track): Promise<boolean> => {
      setError(null);
      const token = ++loadTokenRef.current;
      // Invalidate any previous track's pending analysis.
      pendingAnalysisRef.current = null;

      let phase: "decode" | "fetch" | "playback" | "analyze" = "decode";
      try {
        const [decoded, cover] = await Promise.all([
          DecodeTrack(t.path),
          t.hasCoverArt ? GetCoverArt(t.path) : Promise.resolve(""),
        ]);
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
        // Start with a cheap stand-in analysis so playback can begin
        // without waiting for the full beat-detection pass.
        const minimal = buildMinimalAnalysis(decoded.duration, displayTitle);
        await loadAudio(audioBuffer, minimal);

        const effectiveTitle = t.title || displayTitle;
        const effectiveArtist = decoded.artist || t.artist || "";
        const effectiveAlbum = decoded.album || t.album || "";

        setTrack({
          path: t.path,
          title: effectiveTitle,
          artist: effectiveArtist,
          album: effectiveAlbum,
          coverUrl: cover || null,
          analysis: {
            ...minimal,
            title: effectiveTitle,
          },
          raw: t,
        });

        setEffectsState(effectsState);
        setVolume(volume);
        play();

        // Park the mono + metadata for an optional later analysis. It
        // only happens if the Infinite Jukebox is (or becomes) active —
        // see the jukeboxActive effect below. The main-thread cost of
        // pcmToMonoFloat32 itself is modest (O(n) single pass) so we do
        // it now to keep the heavier analyzeMonoPcm simple.
        phase = "analyze";
        pendingAnalysisRef.current = {
          trackPath: t.path,
          token,
          mono: pcmToMonoFloat32(pcm, decoded.channels),
          sampleRate: decoded.sampleRate,
          duration: decoded.duration,
          displayTitle,
        };

        if (jukeboxActive) {
          setAnalyzing(true);
          scheduleIdle(() => runAnalysisNow());
        } else {
          setAnalyzing(false);
        }

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
      jukeboxActive,
      runAnalysisNow,
    ],
  );

  // When the user toggles Infinite Jukebox on, analyse the *current*
  // track if we skipped analysis at load time. This is why we held onto
  // the mono buffer above.
  useEffect(() => {
    if (!jukeboxActive) return;
    if (!pendingAnalysisRef.current) return;
    setAnalyzing(true);
    scheduleIdle(() => runAnalysisNow());
  }, [jukeboxActive, runAnalysisNow]);

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
  //   otherwise               → engine fires onTrackEnd → we advance
  //                             to queue.next() or pause if empty.
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
    setShouldLoop(shouldLoop);
    if (shouldLoop) {
      setOnTrackEnd(null);
    } else {
      setOnTrackEnd(() => {
        const nxt = queueNextRef.current();
        if (!nxt) pauseRef.current();
      });
    }
    return () => setOnTrackEnd(null);
  }, [jukeboxActive, queue.state.repeat, setShouldLoop, setOnTrackEnd]);

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

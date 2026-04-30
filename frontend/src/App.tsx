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
  PrefetchTrack,
  SaveSettings,
} from "../wailsjs/go/main/App";
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

  const settingsLoaded = useRef(false);

  // Host + settings bootstrap.
  useEffect(() => {
    GetHostInfo()
      .then((h: main.HostInfo) => setPlatform(h.platform))
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
    } as store.Settings).catch(() => {});
  }, [volume, jumpSettings, track?.path]);

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

  const loadAndPlayTrack = useCallback(
    async (t: store.Track): Promise<boolean> => {
      setError(null);
      setAnalyzing(true);
      const token = ++loadTokenRef.current;

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

        // Playback is underway. Now run the real beat analysis in the
        // background and swap it in when ready.
        phase = "analyze";
        const runRealAnalysis = () => {
          if (token !== loadTokenRef.current) return;
          try {
            const mono = pcmToMonoFloat32(pcm, decoded.channels);
            const real = analyzeMonoPcm(
              mono,
              decoded.sampleRate,
              decoded.duration,
              displayTitle,
            );
            if (token !== loadTokenRef.current) return;
            updateAnalysis(real);
            setTrack((prev) =>
              prev && prev.path === t.path
                ? { ...prev, analysis: { ...real, title: effectiveTitle } }
                : prev,
            );
          } catch (e) {
            console.warn("[analyze]", e);
          } finally {
            if (token === loadTokenRef.current) setAnalyzing(false);
          }
        };

        const scheduleAnalysis =
          typeof (window as unknown as { requestIdleCallback?: (cb: () => void) => number })
            .requestIdleCallback === "function"
            ? (window as unknown as {
                requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number;
              }).requestIdleCallback
            : (cb: () => void) => window.setTimeout(cb, 50);
        scheduleAnalysis(runRealAnalysis, { timeout: 1500 } as { timeout: number });

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
      updateAnalysis,
      getContext,
      play,
      setEffectsState,
      setVolume,
      effectsState,
      volume,
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

  // Auto-advance at track end. We poll on a short interval and fire
  // `queue.next()` a bit BEFORE the engine's internal "loop back to beat
  // 0" threshold (which lives in runPlaybackLoop at duration - 0.1s).
  // When jukeboxActive is on, we leave the engine to handle looping so
  // jumps keep working; when repeat is "one" we also leave the engine
  // alone so the loop-back at end IS the repeat behavior.
  useEffect(() => {
    if (!track) return;
    if (jukeboxActive) return;
    if (queue.state.repeat === "one") return;
    if (!playbackState.isPlaying) return;
    const duration = track.analysis.duration;
    if (!duration || duration <= 0) return;
    let fired = false;
    const interval = setInterval(() => {
      if (fired) return;
      const now = getCurrentAudioTime();
      // Fire at least 0.6s before the engine's internal loop-back, so
      // the queue gets to pick the next track before looping kicks in.
      if (now >= duration - 0.6) {
        fired = true;
        const nxt = queue.next();
        if (!nxt) {
          // Nothing to go to — stop playback.
          pause();
        }
      }
    }, 120);
    return () => clearInterval(interval);
  }, [
    track,
    playbackState.isPlaying,
    jukeboxActive,
    queue,
    queue.state.repeat,
    getCurrentAudioTime,
    pause,
  ]);

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
          <div className="h-full overflow-y-auto scroll-thin px-10 py-6">
            <header className="mb-5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                Signal chain
              </p>
              <h1 className="text-2xl font-bold tracking-tight">Effects</h1>
              <p className="mt-1 text-xs text-muted-foreground">
                Every change is click-free, even mid-jump.
              </p>
            </header>
            <div className="max-w-2xl rounded-2xl glass p-5">
              <EffectsPanel state={effectsState} onChange={handleEffects} />
            </div>
          </div>
        );
      case "library":
      default:
        return (
          <LibraryView
            currentPath={track?.path}
            onPlay={playTrackFromList}
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
  ]);

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      <BlurBackground coverUrl={track?.coverUrl} isPlaying={playbackState.isPlaying} />

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

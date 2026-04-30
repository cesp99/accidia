import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TitleBar } from "@/components/shell/titlebar";
import { BlurBackground } from "@/components/shell/background";
import { Sidebar, type View } from "@/components/shell/sidebar";
import { PlayerBar } from "@/components/shell/player-bar";
import { NowPlaying } from "@/components/shell/now-playing";
import { LyricsView } from "@/components/shell/lyrics-view";
import { LibraryView } from "@/components/library/library-view";
import { EffectsPanel } from "@/components/jukebox/effects-panel";
import { FFmpegDialog } from "@/components/shell/ffmpeg-dialog";
import { HealthBanner } from "@/components/shell/health-banner";
import { useAudioEngine, type AnalysisData, type JumpSettings, type EffectsState } from "@/hooks/use-audio-engine";
import { defaultEffectsState } from "@/lib/audio-effects";
import { analyzeMonoPcm } from "@/lib/audio-analysis";
import { fetchPcm, pcmToAudioBuffer, pcmToMonoFloat32 } from "@/lib/pcm";
import {
  DecodeTrack,
  GetCoverArt,
  HostInfo,
  LoadSettings,
  SaveSettings,
} from "../wailsjs/go/main/App";
import type { main } from "../wailsjs/go/models";

interface NowPlayingTrack {
  path: string;
  title: string;
  artist?: string;
  album?: string;
  coverUrl?: string | null;
  analysis: AnalysisData;
}

export default function App() {
  const [platform, setPlatform] = useState<string>("");
  const [view, setView] = useState<View>("library");
  const [track, setTrack] = useState<NowPlayingTrack | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // When ffmpeg is needed but missing, we stash the track request and
  // prompt the user. Once they accept + the install completes, we auto-
  // replay the same track.
  const [ffmpegPromptFor, setFfmpegPromptFor] = useState<main.Track | null>(null);

  // Infinite Jukebox feature toggle. Off by default — the user has to opt
  // in via the sidebar toggle. Persisted across sessions.
  const [jukeboxActive, setJukeboxActive] = useState(false);

  const {
    loadAudio,
    getContext,
    play,
    pause,
    seek,
    seekToTime,
    setJumpSettings,
    setEffectsState,
    setVolume,
    playbackState,
  } = useAudioEngine();

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
    HostInfo()
      .then((h: main.HostInfo) => setPlatform(h.platform))
      .catch(() => setPlatform("web"));
  }, []);

  useEffect(() => {
    LoadSettings()
      .then((s: main.Settings) => {
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
    } as main.Settings).catch(() => {});
  }, [volume, jumpSettings, track?.path]);

  const handlePlayPause = useCallback(() => {
    if (!track) return;
    if (playbackState.isPlaying) pause();
    else play();
  }, [playbackState.isPlaying, play, pause, track]);

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

  // Loading a track. Pipeline:
  //
  //   Go:  file → int16 PCM bytes → MediaStore
  //   JS:  fetch /media/<token> → Int16Array
  //        ├─ mono Float32 → beat analysis
  //        └─ pcmToAudioBuffer → Web Audio
  //
  // We build the AudioBuffer manually via `createBuffer + copyToChannel`
  // which means we never call `decodeAudioData`. WebKit2GTK's Web Audio
  // decoder has historically refused even well-formed WAV bytes; this
  // path removes that whole class of failure.
  const handlePlayTrack = useCallback(
    async (t: main.Track) => {
      setError(null);
      setAnalyzing(true);
      setView("now-playing");

      let phase: "decode" | "fetch" | "analyze" | "playback" = "decode";
      try {
        // 1. Ask Go to decode the file to 16-bit PCM and publish the bytes.
        const [decoded, cover] = await Promise.all([
          DecodeTrack(t.path),
          t.hasCoverArt ? GetCoverArt(t.path) : Promise.resolve(""),
        ]);
        if (!decoded.mediaUrl) {
          throw new Error("Go decoder returned no media URL");
        }

        // 2. Fetch raw PCM bytes over HTTP (not JSON-IPC).
        phase = "fetch";
        const pcm = await fetchPcm(decoded.mediaUrl);

        // 3. Beat analysis on a mono float preview — no extra AudioContext.
        phase = "analyze";
        const displayTitle = decoded.title || t.title;
        const mono = pcmToMonoFloat32(pcm, decoded.channels);
        const analysis = analyzeMonoPcm(
          mono,
          decoded.sampleRate,
          decoded.duration,
          displayTitle,
        );

        // 4. Build the AudioBuffer in the engine's own context, then hand it
        //    off. loadAudio sees an AudioBuffer and skips decodeAudioData.
        phase = "playback";
        const ctx = getContext();
        const audioBuffer = pcmToAudioBuffer(
          ctx,
          pcm,
          decoded.sampleRate,
          decoded.channels,
          decoded.frames,
        );
        await loadAudio(audioBuffer, analysis);

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
            ...analysis,
            title: effectiveTitle,
          },
        });

        // Re-apply current effects/volume in case the engine just spun up
        // a fresh AudioContext.
        setEffectsState(effectsState);
        setVolume(volume);
        play();
      } catch (e) {
        const msg = formatError(e);
        if (msg.startsWith("ffmpeg-required")) {
          setFfmpegPromptFor(t);
          setView("library");
        } else {
          console.error(`[${phase}]`, e);
          setError(`${phase}: ${msg}`);
        }
      } finally {
        setAnalyzing(false);
      }
    },
    [loadAudio, getContext, play, setEffectsState, setVolume, effectsState, volume],
  );

  // Called by FFmpegDialog when the install succeeds. Resume the track
  // the user originally tried to play.
  const handleFFmpegInstalled = useCallback(() => {
    const t = ffmpegPromptFor;
    setFfmpegPromptFor(null);
    if (t) handlePlayTrack(t);
  }, [ffmpegPromptFor, handlePlayTrack]);

  const mainView = useMemo(() => {
    switch (view) {
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
        return <LibraryView currentPath={track?.path} onPlay={handlePlayTrack} />;
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
    handlePlayTrack,
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
        />
        <main className="relative min-h-0 flex-1 overflow-hidden">
          {mainView}
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
      />

      <FFmpegDialog
        open={!!ffmpegPromptFor}
        trackName={ffmpegPromptFor?.title ?? "this track"}
        onCancel={() => setFfmpegPromptFor(null)}
        onInstalled={handleFFmpegInstalled}
      />
    </div>
  );
}

function formatError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

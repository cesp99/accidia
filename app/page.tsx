"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { BeatCircle } from "@/components/jukebox/beat-circle";
import { UploadForm } from "@/components/jukebox/upload-form";
import { PlayerControls } from "@/components/jukebox/player-controls";
import { useAudioEngine } from "@/hooks/use-audio-engine";
import type { AnalysisData, JumpSettings } from "@/hooks/use-audio-engine";
import { Infinity, Music2, AlertCircle } from "lucide-react";

type AppState = "idle" | "loading" | "playing";

function LoadingVisualization() {
  return (
    <div className="relative flex items-center justify-center w-[min(600px,90vw)] h-[min(600px,90vw)]">
      {/* Pulsing rings */}
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="absolute rounded-full border border-primary/30 animate-ping"
          style={{
            width: `${i * 30}%`,
            height: `${i * 30}%`,
            animationDelay: `${i * 0.3}s`,
            animationDuration: "2s",
          }}
        />
      ))}
      <div className="flex flex-col items-center gap-3 z-10">
        <div className="w-16 h-16 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center animate-pulse">
          <Music2 size={28} className="text-primary" />
        </div>
        <div className="text-center space-y-1">
          <p className="text-sm font-medium text-foreground">Analyzing patterns...</p>
          <p className="text-xs text-muted-foreground">Detecting beats & finding loops</p>
        </div>
        {/* Animated beat dots */}
        <div className="flex gap-1.5 mt-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce"
              style={{ animationDelay: `${i * 0.1}s` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [appState, setAppState] = useState<AppState>("idle");
  const [analysisData, setAnalysisData] = useState<AnalysisData | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const audioLoaded = useRef(false);

  const { loadAudio, play, pause, seek, seekToTime, reset, setJumpSettings, playbackState } = useAudioEngine();

  const [jumpSettings, setJumpSettingsState] = useState<JumpSettings>({
    jumpProbability: 0.25,
    minSecondsBetweenJumps: 2,
  });

  const handleJumpSettingsChange = useCallback(
    (partial: Partial<JumpSettings>) => {
      setJumpSettingsState((prev) => {
        const next = { ...prev, ...partial };
        setJumpSettings(next);
        return next;
      });
    },
    [setJumpSettings]
  );

  const handleAnalysisComplete = useCallback(
    async (file: File, data: AnalysisData) => {
      setAnalysisData(data);
      setAppState("loading");

      try {
        await loadAudio(file, data);
        audioLoaded.current = true;
        setAppState("playing");
        play();
      } catch (e: unknown) {
        setErrorMsg(e instanceof Error ? e.message : "Failed to load audio");
        setAppState("idle");
      }
    },
    [loadAudio, play]
  );

  const handlePlayPause = useCallback(() => {
    if (playbackState.isPlaying) {
      pause();
    } else {
      play();
    }
  }, [playbackState.isPlaying, play, pause]);

  const handleReset = useCallback(() => {
    reset();
    setAnalysisData(null);
    setAppState("idle");
    setErrorMsg("");
    audioLoaded.current = false;
  }, [reset]);

  const handleBeatClick = useCallback(
    (beatIndex: number) => {
      seek(beatIndex);
    },
    [seek]
  );

  // Auto-resume AudioContext on interaction
  useEffect(() => {
    const handleInteraction = () => {
      // AudioContext will be created/resumed in the engine
    };
    window.addEventListener("click", handleInteraction, { once: true });
    return () => window.removeEventListener("click", handleInteraction);
  }, []);

  const showVisualizer = appState === "playing" && analysisData;

  return (
    <main className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-border/30">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center">
            <Infinity size={16} className="text-primary" />
          </div>
          <div>
            <span className="text-sm font-bold text-foreground tracking-tight">
              Infinite Jukebox
            </span>
            <span className="hidden sm:inline text-xs text-muted-foreground ml-2">
              by beat pattern analysis
            </span>
          </div>
        </div>

        {showVisualizer && (
          <button
            onClick={handleReset}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5 px-3 py-1.5 rounded-lg hover:bg-surface"
          >
            Load new song
          </button>
        )}
      </header>

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 gap-8">
        {/* Idle state */}
        {appState === "idle" && (
          <div className="w-full max-w-2xl space-y-8 animate-fade-in">
            {/* Hero */}
            <div className="text-center space-y-3">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-xs text-primary mb-2">
                <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                Audio Pattern Analysis
              </div>
              <h1 className="text-4xl sm:text-5xl font-bold text-foreground tracking-tight text-balance">
                Songs that play{" "}
                <span className="text-primary">forever</span>
              </h1>
              <p className="text-muted-foreground text-sm sm:text-base max-w-md mx-auto text-pretty leading-relaxed">
                Upload any audio file. The app finds similar-sounding beats and jumps between them
                to create an infinite loop, visualized as an orbital beat map.
              </p>
            </div>

            {/* Error */}
            {errorMsg && (
              <div className="flex items-start gap-3 p-4 rounded-xl bg-destructive/10 border border-destructive/20 text-sm text-destructive-foreground">
                <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" />
                <span>{errorMsg}</span>
              </div>
            )}

            <UploadForm
              onAnalysisComplete={handleAnalysisComplete}
              onError={setErrorMsg}
              isLoading={isLoading}
              setIsLoading={setIsLoading}
            />

            {/* Feature hints */}
            <div className="grid grid-cols-3 gap-3 text-center">
              {[
                { label: "Beat Detection", desc: "In-browser audio analysis" },
                { label: "Similarity Graph", desc: "Client-side cosine matching" },
                { label: "Infinite Loop", desc: "Random beat jumps" },
              ].map((f) => (
                <div
                  key={f.label}
                  className="p-3 rounded-xl bg-surface/60 border border-border/30 space-y-1"
                >
                  <p className="text-xs font-medium text-foreground">{f.label}</p>
                  <p className="text-xs text-muted-foreground">{f.desc}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Loading state */}
        {appState === "loading" && <LoadingVisualization />}

        {/* Playing state */}
        {showVisualizer && (
          <div className="w-full flex flex-col items-center gap-8 animate-fade-in">
            {/* Circular beat map */}
            <div className="relative mb-2 w-full max-w-[600px] md:mb-4">
              {/* Outer glow ring */}
              <div
                className="absolute inset-0 rounded-full pointer-events-none"
                style={{
                  background:
                    "radial-gradient(ellipse at center, rgba(0,229,255,0.04) 0%, transparent 70%)",
                }}
              />
              <BeatCircle
                beats={analysisData.beats}
                edges={analysisData.edges}
                currentBeat={playbackState.currentBeat}
                lastJump={playbackState.lastJump}
                duration={analysisData.duration}
                onBeatClick={handleBeatClick}
              />
            </div>

            {/* Player controls */}
            <PlayerControls
              isPlaying={playbackState.isPlaying}
              onPlayPause={handlePlayPause}
              onReset={handleReset}
              currentBeat={playbackState.currentBeat}
              totalBeats={analysisData.n_beats}
              bpm={analysisData.bpm}
              jumpCount={playbackState.jumpCount}
              title={analysisData.title}
              currentTime={playbackState.currentTime}
              duration={analysisData.duration}
              playedSeconds={playbackState.playedSeconds}
              jumpSettings={jumpSettings}
              onSeekTime={seekToTime}
              onJumpSettingsChange={handleJumpSettingsChange}
            />
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="px-6 py-3 border-t border-border/20 flex items-center justify-center">
        <p className="text-xs text-muted-foreground">
          Inspired by the original Infinite Jukebox by Paul Lamere
        </p>
      </footer>
    </main>
  );
}

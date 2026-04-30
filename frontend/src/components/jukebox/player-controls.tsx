import { useMemo, useState } from "react";
import {
  Play,
  Pause,
  RotateCcw,
  Shuffle,
  Zap,
  Timer,
  Gauge,
  Volume2,
  VolumeX,
  Volume1,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Slider } from "@/components/ui/slider";
import { EffectsPanel } from "@/components/jukebox/effects-panel";
import type { JumpSettings, EffectsState } from "@/hooks/use-audio-engine";

interface PlayerControlsProps {
  isPlaying: boolean;
  onPlayPause: () => void;
  onReset: () => void;
  currentBeat: number;
  totalBeats: number;
  bpm: number;
  jumpCount: number;
  title: string;
  currentTime: number;
  duration: number;
  playedSeconds: number;
  jumpSettings: JumpSettings;
  effectsState: EffectsState;
  volume: number;
  onSeekTime: (timeSeconds: number) => void;
  onJumpSettingsChange: (partial: Partial<JumpSettings>) => void;
  onEffectsChange: (next: EffectsState) => void;
  onVolumeChange: (volume: number) => void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatPlayTime(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function chaosLabel(prob: number): string {
  if (prob === 0) return "Off";
  if (prob <= 0.15) return "Subtle";
  if (prob <= 0.35) return "Moderate";
  if (prob <= 0.6) return "Energetic";
  return "Chaotic";
}

export function PlayerControls({
  isPlaying,
  onPlayPause,
  onReset,
  currentBeat,
  totalBeats,
  bpm,
  jumpCount,
  title,
  currentTime,
  duration,
  playedSeconds,
  jumpSettings,
  effectsState,
  volume,
  onSeekTime,
  onJumpSettingsChange,
  onEffectsChange,
  onVolumeChange,
}: PlayerControlsProps) {
  const probPct = Math.round(jumpSettings.jumpProbability * 100);
  const label = chaosLabel(jumpSettings.jumpProbability);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState(currentTime);
  const [activeTab, setActiveTab] = useState<"jumps" | "effects">("jumps");
  const [volumeBeforeMute, setVolumeBeforeMute] = useState(1);
  const timelineTime = useMemo(
    () => (isScrubbing ? scrubValue : currentTime),
    [isScrubbing, scrubValue, currentTime]
  );

  const isMuted = volume <= 0.001;
  const VolumeIcon = isMuted ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const toggleMute = () => {
    if (isMuted) {
      onVolumeChange(volumeBeforeMute > 0.01 ? volumeBeforeMute : 1);
    } else {
      setVolumeBeforeMute(volume);
      onVolumeChange(0);
    }
  };

  return (
    <div className="w-full max-w-lg mx-auto space-y-5">
      {/* Title */}
      <div className="text-center">
        <p className="text-xs text-muted-foreground uppercase tracking-widest mb-1">Now Playing</p>
        <h2 className="text-lg font-semibold text-foreground text-balance truncate">{title}</h2>
      </div>

      {/* Beat progress bar */}
      <div className="space-y-1.5">
        <Slider
          min={0}
          max={Math.max(0.1, duration)}
          step={0.01}
          value={[timelineTime]}
          onValueChange={([v]) => {
            setIsScrubbing(true);
            setScrubValue(v);
          }}
          onValueCommit={([v]) => {
            setIsScrubbing(false);
            onSeekTime(v);
          }}
          className="[&_[data-slot=slider-range]]:bg-primary [&_[data-slot=slider-thumb]]:size-4 [&_[data-slot=slider-thumb]]:border-primary"
          aria-label="Song position"
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{formatTime(timelineTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      {/* Transport */}
      <div className="flex items-center justify-center gap-4">
        <button
          onClick={onReset}
          className="w-10 h-10 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-all"
          aria-label="Reset"
        >
          <RotateCcw size={18} />
        </button>

        <button
          onClick={onPlayPause}
          className={cn(
            "w-14 h-14 rounded-full flex items-center justify-center transition-all",
            "bg-primary text-primary-foreground shadow-lg shadow-primary/30",
            "hover:brightness-110 active:scale-95"
          )}
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying
            ? <Pause size={22} fill="currentColor" />
            : <Play size={22} fill="currentColor" className="ml-0.5" />}
        </button>

        <button
          onClick={toggleMute}
          className="w-10 h-10 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-all"
          aria-label={isMuted ? "Unmute" : "Mute"}
        >
          <VolumeIcon size={18} />
        </button>
      </div>

      {/* Volume */}
      <div className="flex items-center gap-3 px-1">
        <VolumeIcon
          size={14}
          className={cn(
            "shrink-0 transition-colors",
            isMuted ? "text-muted-foreground/50" : "text-muted-foreground",
          )}
          aria-hidden
        />
        <Slider
          min={0}
          max={1}
          step={0.01}
          value={[volume]}
          onValueChange={([v]) => onVolumeChange(v)}
          className="flex-1 [&_[data-slot=slider-range]]:bg-muted-foreground/60 [&_[data-slot=slider-thumb]]:border-muted-foreground/80 [&_[data-slot=slider-thumb]]:size-3"
          aria-label="Volume"
        />
        <span className="text-xs tabular-nums text-muted-foreground w-9 text-right font-mono">
          {Math.round(volume * 100)}%
        </span>
      </div>

      {/* Stats row */}
      <div className="flex items-center justify-center gap-6 text-xs">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <span className="w-1.5 h-1.5 rounded-full bg-primary inline-block" />
          <span>Beat {currentBeat + 1} / {totalBeats}</span>
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <span className="w-1.5 h-1.5 rounded-full bg-accent inline-block" />
          <span>{Math.round(bpm)} BPM</span>
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Shuffle size={11} />
          <span>{jumpCount} jumps</span>
        </div>
      </div>
      <p className="text-center text-xs text-muted-foreground">
        Played for <span className="font-mono tabular-nums">{formatPlayTime(playedSeconds)}</span>
      </p>

      {/* Modifiers panel with tabs for jump controls and audio effects */}
      <div className="rounded-xl border border-border/50 bg-card p-5 space-y-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Gauge size={13} className="text-muted-foreground" />
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
              Controls
            </span>
          </div>
          <div
            role="tablist"
            aria-label="Player controls tabs"
            className="inline-flex rounded-lg bg-secondary/60 border border-border/30 p-0.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "jumps"}
              onClick={() => setActiveTab("jumps")}
              className={cn(
                "px-3 py-1 text-xs rounded-md transition-colors",
                activeTab === "jumps"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Jumps
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "effects"}
              onClick={() => setActiveTab("effects")}
              className={cn(
                "px-3 py-1 text-xs rounded-md transition-colors",
                activeTab === "effects"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Effects
            </button>
          </div>
        </div>

        {activeTab === "jumps" ? (
          <div className="space-y-5">
            {/* Jump probability */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Zap size={13} className="text-primary" />
                  <span className="text-sm font-medium text-foreground">Jump Probability</span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "text-xs px-2 py-0.5 rounded-md font-mono font-medium",
                      probPct === 0
                        ? "bg-secondary text-muted-foreground"
                        : probPct <= 35
                        ? "bg-primary/15 text-primary"
                        : "bg-accent/15 text-accent"
                    )}
                  >
                    {label}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground w-8 text-right">
                    {probPct}%
                  </span>
                </div>
              </div>
              <Slider
                min={0}
                max={100}
                step={1}
                value={[probPct]}
                onValueChange={([v]) => onJumpSettingsChange({ jumpProbability: v / 100 })}
                className="[&_[data-slot=slider-range]]:bg-primary [&_[data-slot=slider-thumb]]:border-primary"
                aria-label="Jump probability"
              />
              <p className="text-xs text-muted-foreground leading-relaxed">
                How likely the track is to jump to a similar-sounding beat at each beat boundary.
                Set to 0 to disable jumps entirely.
              </p>
            </div>

            {/* Jump cooldown */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Timer size={13} className="text-accent" />
                  <span className="text-sm font-medium text-foreground">Jump Cooldown</span>
                </div>
                <span className="text-xs tabular-nums text-muted-foreground font-mono">
                  {jumpSettings.minSecondsBetweenJumps === 0
                    ? "None"
                    : `${jumpSettings.minSecondsBetweenJumps.toFixed(1)}s`}
                </span>
              </div>
              <Slider
                min={0}
                max={30}
                step={0.5}
                value={[jumpSettings.minSecondsBetweenJumps]}
                onValueChange={([v]) => onJumpSettingsChange({ minSecondsBetweenJumps: v })}
                className="[&_[data-slot=slider-range]]:bg-accent [&_[data-slot=slider-thumb]]:border-accent"
                aria-label="Jump cooldown"
              />
              <p className="text-xs text-muted-foreground leading-relaxed">
                Minimum seconds that must pass before another jump can occur.
                Raise this to hear more of each section before jumping.
              </p>
            </div>
          </div>
        ) : (
          <EffectsPanel state={effectsState} onChange={onEffectsChange} />
        )}
      </div>
    </div>
  );
}

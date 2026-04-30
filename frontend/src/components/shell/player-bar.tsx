import {
  Pause,
  Play,
  Volume2,
  VolumeX,
  Volume1,
  Disc3,
  Infinity as InfinityIcon,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Repeat1,
  Heart,
  ListMusic,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Slider } from "@/components/ui/slider";
import type { RepeatMode } from "@/hooks/use-queue";

interface PlayerBarProps {
  title?: string;
  artist?: string;
  coverUrl?: string | null;
  isPlaying: boolean;
  onPlayPause: () => void;
  duration: number;
  currentTime: number;
  onSeek: (seconds: number) => void;
  volume: number;
  onVolume: (v: number) => void;
  jumpCount: number;
  bpm?: number;
  /** Click the cover to open the now-playing view. */
  onOpenNowPlaying: () => void;
  /** When no track is loaded we still want a quiet placeholder bar. */
  hasTrack: boolean;
  /** Whether the Infinite Jukebox loop mode is active. */
  jukeboxActive?: boolean;

  // --- Transport / queue controls ---
  onNext: () => void;
  onPrev: () => void;
  hasNext: boolean;
  hasPrev: boolean;
  shuffle: boolean;
  onToggleShuffle: () => void;
  repeat: RepeatMode;
  onCycleRepeat: () => void;

  // --- Favorite + queue ---
  isFavorite: boolean;
  onToggleFavorite: () => void;
  onToggleQueue: () => void;
  queueOpen: boolean;
  upNextCount: number;
}

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function PlayerBar({
  title,
  artist,
  coverUrl,
  isPlaying,
  onPlayPause,
  duration,
  currentTime,
  onSeek,
  volume,
  onVolume,
  jumpCount,
  bpm,
  onOpenNowPlaying,
  hasTrack,
  jukeboxActive,
  onNext,
  onPrev,
  hasNext,
  hasPrev,
  shuffle,
  onToggleShuffle,
  repeat,
  onCycleRepeat,
  isFavorite,
  onToggleFavorite,
  onToggleQueue,
  queueOpen,
  upNextCount,
}: PlayerBarProps) {
  const isMuted = volume <= 0.001;
  const VolumeIcon = isMuted ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <div className="relative z-10 flex h-[84px] shrink-0 items-center gap-5 border-t border-white/5 px-5 glass-strong">
      {/* Cover + title */}
      <div className="flex w-[280px] max-w-[320px] shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onOpenNowPlaying}
          disabled={!hasTrack}
          className={cn(
            "-m-1 flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1 transition-colors",
            hasTrack && "hover:bg-white/5",
          )}
        >
          <div className="relative size-12 shrink-0 overflow-hidden rounded-md bg-white/5">
            {coverUrl ? (
              <img src={coverUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <Disc3 size={18} className="text-muted-foreground/40" />
              </div>
            )}
          </div>
          <div className="min-w-0 text-left">
            <p className="truncate text-sm font-semibold text-foreground">
              {title ?? "Nothing playing"}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {artist ?? (hasTrack ? "Unknown artist" : "Pick a track to start")}
            </p>
          </div>
        </button>
        {hasTrack && (
          <button
            type="button"
            onClick={onToggleFavorite}
            aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
              isFavorite
                ? "text-primary hover:bg-primary/10"
                : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
            )}
          >
            <Heart
              size={15}
              fill={isFavorite ? "currentColor" : "none"}
              strokeWidth={isFavorite ? 0 : 2}
            />
          </button>
        )}
      </div>

      {/* Centre — transport, stats, scrubber */}
      <div className="flex flex-1 flex-col items-stretch gap-1 px-2">
        <div className="flex items-center justify-center gap-1">
          <button
            type="button"
            onClick={onToggleShuffle}
            aria-pressed={shuffle}
            aria-label={shuffle ? "Shuffle on" : "Shuffle off"}
            className={cn(
              "flex size-8 items-center justify-center rounded-full transition-colors",
              shuffle
                ? "text-primary"
                : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
            )}
          >
            <Shuffle size={14} />
          </button>
          <button
            type="button"
            onClick={onPrev}
            disabled={!hasPrev}
            aria-label="Previous track"
            className={cn(
              "flex size-8 items-center justify-center rounded-full transition-colors",
              "text-muted-foreground hover:bg-white/5 hover:text-foreground",
              "disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
            )}
          >
            <SkipBack size={16} fill="currentColor" />
          </button>
          <button
            type="button"
            onClick={onPlayPause}
            disabled={!hasTrack}
            className={cn(
              "flex size-10 items-center justify-center rounded-full transition-all",
              "bg-white text-black shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_2px_12px_rgba(0,0,0,0.35)]",
              "hover:brightness-95 active:scale-95",
              "disabled:cursor-not-allowed disabled:opacity-40",
            )}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <Pause size={16} fill="currentColor" />
            ) : (
              <Play size={16} fill="currentColor" className="ml-0.5" />
            )}
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={!hasNext}
            aria-label="Next track"
            className={cn(
              "flex size-8 items-center justify-center rounded-full transition-colors",
              "text-muted-foreground hover:bg-white/5 hover:text-foreground",
              "disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
            )}
          >
            <SkipForward size={16} fill="currentColor" />
          </button>
          <button
            type="button"
            onClick={onCycleRepeat}
            aria-label={`Repeat: ${repeat}`}
            className={cn(
              "flex size-8 items-center justify-center rounded-full transition-colors",
              repeat === "off"
                ? "text-muted-foreground hover:bg-white/5 hover:text-foreground"
                : "text-primary",
            )}
          >
            {repeat === "one" ? <Repeat1 size={14} /> : <Repeat size={14} />}
          </button>

          {hasTrack && bpm !== undefined && (
            <div className="ml-3 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="font-mono tabular-nums">{Math.round(bpm)} BPM</span>
              {jukeboxActive && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="inline-flex items-center gap-1 text-primary">
                    <InfinityIcon size={11} />
                    <span className="font-mono tabular-nums">{jumpCount}</span>
                  </span>
                </>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="w-10 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
            {formatTime(currentTime)}
          </span>
          <Slider
            min={0}
            max={Math.max(0.1, duration)}
            step={0.01}
            value={[Math.min(currentTime, duration)]}
            onValueChange={([v]) => onSeek(v)}
            disabled={!hasTrack}
            className="flex-1 [&_[data-slot=slider-range]]:bg-white/70 [&_[data-slot=slider-thumb]]:size-3 [&_[data-slot=slider-thumb]]:border-white [&_[data-slot=slider-thumb]]:bg-white"
            aria-label="Song position"
          />
          <span className="w-10 font-mono text-[10px] tabular-nums text-muted-foreground">
            {formatTime(duration)}
          </span>
        </div>
      </div>

      {/* Queue + Volume */}
      <div className="flex w-52 shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onToggleQueue}
          aria-pressed={queueOpen}
          aria-label="Toggle queue"
          className={cn(
            "relative flex size-8 items-center justify-center rounded-full transition-colors",
            queueOpen
              ? "bg-white/10 text-foreground"
              : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
          )}
        >
          <ListMusic size={15} />
          {upNextCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex min-w-[14px] items-center justify-center rounded-full bg-primary px-1 text-[9px] font-bold leading-[14px] text-primary-foreground">
              {upNextCount > 99 ? "99+" : upNextCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => onVolume(isMuted ? 1 : 0)}
          className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-white/5 hover:text-foreground"
          aria-label={isMuted ? "Unmute" : "Mute"}
        >
          <VolumeIcon size={15} />
        </button>
        <Slider
          min={0}
          max={1}
          step={0.01}
          value={[volume]}
          onValueChange={([v]) => onVolume(v)}
          className="flex-1 [&_[data-slot=slider-range]]:bg-white/50 [&_[data-slot=slider-thumb]]:size-3 [&_[data-slot=slider-thumb]]:border-white [&_[data-slot=slider-thumb]]:bg-white"
          aria-label="Volume"
        />
      </div>
    </div>
  );
}

import { Pause, Play, Volume2, VolumeX, Volume1, Disc3, Infinity as InfinityIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Slider } from "@/components/ui/slider";

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
}: PlayerBarProps) {
  const isMuted = volume <= 0.001;
  const VolumeIcon = isMuted ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <div className="relative z-10 flex h-[84px] shrink-0 items-center gap-5 border-t border-white/5 px-5 glass-strong">
      {/* Cover + title */}
      <button
        type="button"
        onClick={onOpenNowPlaying}
        disabled={!hasTrack}
        className={cn(
          "-m-1 flex min-w-0 items-center gap-3 rounded-lg p-1 transition-colors",
          "w-[240px] max-w-[280px] shrink-0",
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

      {/* Centre — transport, stats, scrubber */}
      <div className="flex flex-1 flex-col items-stretch gap-1 px-2">
        <div className="flex items-center justify-center gap-3">
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
          {hasTrack && bpm !== undefined && (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
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

      {/* Volume */}
      <div className="flex w-40 shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => onVolume(isMuted ? 1 : 0)}
          className="text-muted-foreground hover:text-foreground"
          aria-label={isMuted ? "Unmute" : "Mute"}
        >
          <VolumeIcon size={16} />
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

import { Disc3, Music2, Infinity as InfinityIcon, ArrowRight } from "lucide-react";
import { BeatCircle } from "@/components/jukebox/beat-circle";
import type { AnalysisData, PlaybackState, JumpSettings } from "@/hooks/use-audio-engine";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

interface NowPlayingProps {
  title?: string;
  artist?: string;
  album?: string;
  coverUrl?: string | null;
  analysis: AnalysisData | null;
  playback: PlaybackState;
  isAnalyzing: boolean;
  onSeekBeat: (beatIndex: number) => void;
  jumpSettings: JumpSettings;
  onJumpSettingsChange: (partial: Partial<JumpSettings>) => void;
  jukeboxActive: boolean;
  onToggleJukebox: () => void;
}

/**
 * Now-Playing view. Two modes:
 *
 *  - Jukebox OFF  → "big cover art + title" album hero
 *  - Jukebox ON   → beat-map visualisation + jump controls
 *
 * Layout, typography and alignment follow the same calmer palette used
 * elsewhere: no inline gradients, subtle glass panels, accent colour
 * used only for active state.
 */
export function NowPlaying({
  title,
  artist,
  album,
  coverUrl,
  analysis,
  playback,
  isAnalyzing,
  onSeekBeat,
  jumpSettings,
  onJumpSettingsChange,
  jukeboxActive,
  onToggleJukebox,
}: NowPlayingProps) {
  if (!analysis) {
    return (
      <div className="flex h-full items-center justify-center px-10">
        <div className="flex max-w-sm flex-col items-center gap-4 text-center">
          <div
            className={cn(
              "flex size-16 items-center justify-center rounded-full bg-white/5",
              isAnalyzing && "animate-pulse",
            )}
          >
            {isAnalyzing ? (
              <Music2 size={22} className="text-primary" />
            ) : (
              <Disc3 size={22} className="text-muted-foreground/50" />
            )}
          </div>
          <p className="text-base font-semibold text-foreground">
            {isAnalyzing ? "Analyzing beat patterns…" : "Nothing playing"}
          </p>
          <p className="text-sm text-muted-foreground">
            {isAnalyzing
              ? "Detecting beats and finding loops"
              : "Pick a song from the library to start."}
          </p>
        </div>
      </div>
    );
  }

  return jukeboxActive ? (
    <JukeboxView
      title={title}
      artist={artist}
      coverUrl={coverUrl}
      analysis={analysis}
      playback={playback}
      onSeekBeat={onSeekBeat}
      jumpSettings={jumpSettings}
      onJumpSettingsChange={onJumpSettingsChange}
      onToggleJukebox={onToggleJukebox}
    />
  ) : (
    <AlbumHeroView
      title={title}
      artist={artist}
      album={album}
      coverUrl={coverUrl}
      analysis={analysis}
      playback={playback}
      onToggleJukebox={onToggleJukebox}
    />
  );
}

/**
 * Default view when the Infinite Jukebox feature is off — a clean,
 * large album-art presentation. Acts like a "big now-playing" card.
 */
function AlbumHeroView({
  title,
  artist,
  album,
  coverUrl,
  analysis,
  playback,
  onToggleJukebox,
}: {
  title?: string;
  artist?: string;
  album?: string;
  coverUrl?: string | null;
  analysis: AnalysisData;
  playback: PlaybackState;
  onToggleJukebox: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-8 px-10 py-8">
      <div className="relative size-[min(60vh,360px)] shrink-0 overflow-hidden rounded-3xl bg-white/5 shadow-[0_24px_80px_-20px_rgba(0,0,0,0.8)]">
        {coverUrl ? (
          <img src={coverUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Disc3 size={56} className="text-muted-foreground/40" />
          </div>
        )}
      </div>

      <div className="flex max-w-xl flex-col items-center gap-2 text-center">
        <h1 className="text-3xl font-bold tracking-tight text-foreground text-balance">
          {title ?? analysis.title}
        </h1>
        {artist && (
          <p className="text-base text-muted-foreground">
            {artist}
            {album && <span className="text-muted-foreground/60"> · {album}</span>}
          </p>
        )}
        <p className="mt-2 text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground/60">
          {Math.round(analysis.bpm)} BPM · {analysis.n_beats} beats
          {playback.jumpCount > 0 && ` · ${playback.jumpCount} jumps`}
        </p>
      </div>

      {/* Gentle nudge toward the loop feature */}
      <button
        type="button"
        onClick={onToggleJukebox}
        className={cn(
          "group inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2",
          "text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary",
        )}
      >
        <InfinityIcon size={13} />
        Enable Infinite Jukebox mode
        <ArrowRight
          size={12}
          className="transition-transform group-hover:translate-x-0.5"
        />
      </button>
    </div>
  );
}

/**
 * Infinite Jukebox view — the beat map + jump controls.
 */
function JukeboxView({
  title,
  artist,
  coverUrl,
  analysis,
  playback,
  onSeekBeat,
  jumpSettings,
  onJumpSettingsChange,
  onToggleJukebox,
}: {
  title?: string;
  artist?: string;
  coverUrl?: string | null;
  analysis: AnalysisData;
  playback: PlaybackState;
  onSeekBeat: (beatIndex: number) => void;
  jumpSettings: JumpSettings;
  onJumpSettingsChange: (partial: Partial<JumpSettings>) => void;
  onToggleJukebox: () => void;
}) {
  const probPct = Math.round(jumpSettings.jumpProbability * 100);
  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto scroll-thin px-10 py-6">
      <header className="flex items-center gap-4">
        <div className="relative size-16 shrink-0 overflow-hidden rounded-xl bg-white/5">
          {coverUrl ? (
            <img src={coverUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <Disc3 size={22} className="text-muted-foreground/40" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-bold tracking-tight text-foreground">
            {title ?? analysis.title}
          </h1>
          {artist && <p className="truncate text-sm text-muted-foreground">{artist}</p>}
          <p className="mt-1 text-[11px] font-mono uppercase tracking-[0.18em] text-muted-foreground/70">
            {Math.round(analysis.bpm)} BPM · {analysis.n_beats} beats · {playback.jumpCount} jumps
          </p>
        </div>
        <button
          type="button"
          onClick={onToggleJukebox}
          className="rounded-full border border-primary/40 bg-primary/15 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-primary hover:bg-primary/20"
        >
          Looping
        </button>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[1fr_300px]">
        {/* Beat map */}
        <div className="relative flex min-h-[320px] items-center justify-center overflow-hidden rounded-2xl glass p-4">
          <div className="relative w-full max-w-[520px]">
            <BeatCircle
              beats={analysis.beats}
              edges={analysis.edges}
              currentBeat={playback.currentBeat}
              lastJump={playback.lastJump}
              duration={analysis.duration}
              onBeatClick={onSeekBeat}
            />
          </div>
        </div>

        {/* Jump controls */}
        <div className="flex flex-col gap-5 rounded-2xl glass p-5">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Jump engine
            </p>
            <p className="mt-1 text-xs text-muted-foreground/80">
              Cyan arcs are similar-sounding pairs the engine can hop between.
            </p>
          </div>

          <Control
            label="Probability"
            value={`${probPct}%`}
            slider={
              <Slider
                min={0}
                max={100}
                step={1}
                value={[probPct]}
                onValueChange={([v]) => onJumpSettingsChange({ jumpProbability: v / 100 })}
                className="[&_[data-slot=slider-range]]:bg-primary [&_[data-slot=slider-thumb]]:border-primary"
                aria-label="Jump probability"
              />
            }
            hint="Chance of jumping at each beat boundary."
          />
          <Control
            label="Cooldown"
            value={
              jumpSettings.minSecondsBetweenJumps === 0
                ? "Off"
                : `${jumpSettings.minSecondsBetweenJumps.toFixed(1)} s`
            }
            slider={
              <Slider
                min={0}
                max={30}
                step={0.5}
                value={[jumpSettings.minSecondsBetweenJumps]}
                onValueChange={([v]) => onJumpSettingsChange({ minSecondsBetweenJumps: v })}
                className="[&_[data-slot=slider-range]]:bg-white/40 [&_[data-slot=slider-thumb]]:border-white/70"
                aria-label="Jump cooldown"
              />
            }
            hint="Minimum seconds between jumps."
          />
        </div>
      </div>
    </div>
  );
}

function Control({
  label,
  value,
  slider,
  hint,
}: {
  label: string;
  value: string;
  slider: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-foreground">{label}</span>
        <span className="text-[11px] font-mono tabular-nums text-muted-foreground">{value}</span>
      </div>
      {slider}
      {hint && (
        <p className="text-[11px] leading-relaxed text-muted-foreground/80">{hint}</p>
      )}
    </div>
  );
}

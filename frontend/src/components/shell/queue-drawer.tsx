import { Disc3, X, Trash2, GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Track } from "@/hooks/use-queue";

interface QueueDrawerProps {
  open: boolean;
  onClose: () => void;
  current: Track | null;
  currentCover: string | null;
  upNext: Track[];
  /** Tracks that will play after upNext runs out, taken from the source. */
  comingUp: Track[];
  onRemove: (index: number) => void;
  onClear: () => void;
  onPlayIndex: (track: Track, index: number) => void;
  /** Called when the user clicks a track in the "coming up" list. */
  onJumpToSourceTrack: (track: Track) => void;
}

/**
 * Right-docked queue panel. Three sections:
 *   1. Currently playing (just the one)
 *   2. Up Next — manually-queued (the "Play Next" / "Add to Queue" lanes)
 *   3. Coming Up — next few tracks from the active source
 *
 * Stays simple visually; reorder isn't included in v1. Remove + clear are
 * enough to make the queue feel usable.
 */
export function QueueDrawer({
  open,
  onClose,
  current,
  currentCover,
  upNext,
  comingUp,
  onRemove,
  onClear,
  onPlayIndex,
  onJumpToSourceTrack,
}: QueueDrawerProps) {
  if (!open) return null;
  return (
    <aside
      className={cn(
        "absolute right-0 top-0 bottom-0 z-30 flex w-[340px] flex-col",
        // A strongly opaque dark panel (not the lighter `glass-strong`)
        // because the queue overlays the Now Playing pane — Jump
        // Engine labels and sliders sit directly underneath. The old
        // 5%-white-on-blur was too transparent and the labels bled
        // through on top of the queue list. We still keep a backdrop
        // blur so users running a low backdrop-opacity setting still
        // get the wallpaper hint at the panel edges, but the dark
        // base is opaque enough that the app content under the panel
        // is fully hidden.
        "border-l border-white/10",
        "bg-[oklch(0.10_0.004_240)]/95 backdrop-blur-2xl backdrop-saturate-150",
        "shadow-[-12px_0_40px_-12px_rgba(0,0,0,0.55)]",
      )}
      aria-label="Play queue"
    >
      <header className="flex items-center justify-between border-b border-white/5 px-4 py-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Play queue
          </p>
          <h2 className="text-sm font-semibold text-foreground">
            {upNext.length > 0
              ? `${upNext.length} queued`
              : "Nothing queued"}
          </h2>
        </div>
        <div className="flex items-center gap-1">
          {upNext.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="rounded-md px-2 py-1 text-[11px] uppercase tracking-wider text-muted-foreground hover:bg-white/5 hover:text-foreground"
              aria-label="Clear queue"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close queue"
            className="flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-white/5 hover:text-foreground"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      <div className="scroll-thin flex-1 overflow-y-auto px-3 py-3">
        {/* Currently playing */}
        {current && (
          <section className="mb-4">
            <h3 className="px-1 pb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Now playing
            </h3>
            <QueueRow
              track={current}
              cover={currentCover}
              isCurrent
            />
          </section>
        )}

        {/* Up next — manually queued */}
        {upNext.length > 0 && (
          <section className="mb-4">
            <h3 className="px-1 pb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Up next
            </h3>
            <ul className="space-y-1">
              {upNext.map((t, i) => (
                <li key={`${t.path}-${i}`}>
                  <QueueRow
                    track={t}
                    onClick={() => onPlayIndex(t, i)}
                    onRemove={() => onRemove(i)}
                    draggable
                  />
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Coming up from source */}
        {comingUp.length > 0 && (
          <section>
            <h3 className="px-1 pb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Coming up
            </h3>
            <ul className="space-y-1">
              {comingUp.map((t) => (
                <li key={`source-${t.path}`}>
                  <QueueRow
                    track={t}
                    onClick={() => onJumpToSourceTrack(t)}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}

        {upNext.length === 0 && comingUp.length === 0 && !current && (
          <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
            Your queue is empty.
          </div>
        )}
      </div>
    </aside>
  );
}

function QueueRow({
  track,
  cover,
  isCurrent = false,
  onClick,
  onRemove,
  draggable = false,
}: {
  track: Track;
  cover?: string | null;
  isCurrent?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  draggable?: boolean;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors",
        isCurrent ? "bg-primary/10" : onClick ? "hover:bg-white/5 cursor-pointer" : "",
      )}
      onClick={onClick}
    >
      {draggable && (
        <span
          aria-hidden
          className="shrink-0 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100"
        >
          <GripVertical size={12} />
        </span>
      )}
      <div className="size-9 shrink-0 overflow-hidden rounded-md bg-white/5">
        {cover ? (
          <img src={cover} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Disc3 size={14} className="text-muted-foreground/40" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "truncate text-[13px]",
            isCurrent ? "font-medium text-primary" : "text-foreground",
          )}
        >
          {track.title}
        </p>
        <p className="truncate text-[11px] text-muted-foreground">
          {track.artist || "Unknown artist"}
        </p>
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label="Remove from queue"
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-white/5 hover:text-foreground group-hover:opacity-100"
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

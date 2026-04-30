import { useEffect, useMemo, useRef, useState } from "react";
import { Mic2, Loader2, HeartCrack } from "lucide-react";
import { cn } from "@/lib/utils";
import { FetchLyrics } from "../../../wailsjs/go/main/App";
import type { lyrics } from "../../../wailsjs/go/models";

interface LyricsViewProps {
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  coverUrl?: string | null;
  /** Live playback time (seconds) used to highlight the current line. */
  currentTime: number;
  isPlaying: boolean;
  onSeek: (timeSeconds: number) => void;
}

interface FetchState {
  loading: boolean;
  lyrics: lyrics.Lyrics | null;
  error: string | null;
}

/**
 * Apple-Music-style time-synced lyrics.
 *
 * Design cues:
 *  - Huge, heavy, left-aligned lines. Not a centered lyric card.
 *  - Active line is 100% opaque with a subtle pulse.
 *  - Past lines dim to ~30% opacity.
 *  - Future lines are readable but at ~55% so the eye knows where to go.
 *  - No borders, no panels — the lyrics ARE the canvas.
 *  - Smooth ease-out scroll follows the active line on every tick.
 */
export function LyricsView({
  title,
  artist,
  album,
  duration,
  coverUrl,
  currentTime,
  isPlaying,
  onSeek,
}: LyricsViewProps) {
  const [state, setState] = useState<FetchState>({
    loading: false,
    lyrics: null,
    error: null,
  });

  const key = `${title ?? ""}|${artist ?? ""}|${album ?? ""}`;
  useEffect(() => {
    if (!title || !artist) {
      setState({ loading: false, lyrics: null, error: null });
      return;
    }
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    FetchLyrics(title, artist, album ?? "", duration ?? 0)
      .then((lyrics) => {
        if (cancelled) return;
        setState({ loading: false, lyrics, error: null });
      })
      .catch((e) => {
        if (cancelled) return;
        setState({ loading: false, lyrics: null, error: String(e) });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, duration]);

  const synced = state.lyrics?.syncedLines ?? [];
  const hasSynced = synced.length > 0;
  const plain = state.lyrics?.plain ?? "";

  // Binary-searched active line. O(log n) keeps us stable at 60 fps even
  // for long LRCs with thousands of entries.
  const activeIndex = useMemo(() => {
    if (!hasSynced) return -1;
    if (currentTime < synced[0].timeSec) return -1;
    let lo = 0;
    let hi = synced.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (synced[mid].timeSec <= currentTime) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }, [synced, hasSynced, currentTime]);

  // Smoothly scroll the active line to the viewport centre.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLButtonElement>(
      `[data-line-idx="${activeIndex}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeIndex]);

  if (!title || !artist) {
    return (
      <ShellMsg
        icon={<Mic2 size={28} className="text-muted-foreground/50" />}
        title="No track loaded"
        subtitle="Start a song from the library to see its lyrics."
      />
    );
  }
  if (state.loading) {
    return (
      <ShellMsg
        icon={<Loader2 size={28} className="animate-spin text-primary" />}
        title="Looking up lyrics…"
        subtitle="Querying LRCLIB for a time-synced match"
      />
    );
  }
  if (state.error) {
    return (
      <ShellMsg
        icon={<HeartCrack size={28} className="text-destructive" />}
        title="Couldn't fetch lyrics"
        subtitle={state.error}
      />
    );
  }
  if (state.lyrics?.instrumental) {
    return (
      <ShellMsg
        icon={<Mic2 size={28} className="text-muted-foreground/50" />}
        title="Instrumental"
        subtitle="This track has no lyrics."
      />
    );
  }
  if (!hasSynced && !plain) {
    return (
      <ShellMsg
        icon={<Mic2 size={28} className="text-muted-foreground/50" />}
        title="No lyrics found"
        subtitle={`${title} · ${artist} isn't in LRCLIB yet.`}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Cover + title header — minimal, anchored top-left */}
      <header className="flex shrink-0 items-end gap-4 px-10 pt-6 pb-4">
        <div className="relative size-20 shrink-0 overflow-hidden rounded-xl bg-white/5 shadow-[0_8px_32px_rgba(0,0,0,0.45)]">
          {coverUrl ? (
            <img src={coverUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <Mic2 size={24} className="text-muted-foreground/60" />
            </div>
          )}
        </div>
        <div className="min-w-0 pb-1">
          <h1 className="truncate text-2xl font-bold tracking-tight text-foreground">{title}</h1>
          <p className="truncate text-sm text-muted-foreground">{artist}</p>
        </div>
      </header>

      {/* Lyrics scroll area */}
      {hasSynced ? (
        <div
          ref={listRef}
          className="scroll-thin relative flex-1 overflow-y-auto"
        >
          {/* Generous top spacer so the first line can reach the middle. */}
          <div className="h-[42vh]" />
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-10">
            {synced.map((line, idx) => {
              const isActive = idx === activeIndex;
              const isPast = idx < activeIndex;
              const distance = Math.abs(idx - activeIndex);
              return (
                <button
                  key={idx}
                  type="button"
                  data-line-idx={idx}
                  onClick={() => onSeek(line.timeSec + 0.001)}
                  className={cn(
                    "block cursor-pointer text-left leading-[1.12] tracking-tight transition-all duration-500 ease-out",
                    "font-bold",
                    isActive
                      ? "text-[2.35rem] text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.35)]"
                      : isPast
                        ? "text-[1.75rem] text-white/30"
                        : "text-[1.75rem] text-white/55",
                    !line.text && "opacity-20",
                  )}
                  style={{
                    // Each adjacent line shrinks slightly to draw the eye
                    // toward the active one. Clamp so nothing disappears.
                    filter:
                      !isActive && distance > 2
                        ? `blur(${Math.min((distance - 2) * 0.4, 1.2)}px)`
                        : "none",
                  }}
                >
                  {line.text || "♪"}
                </button>
              );
            })}
          </div>
          {/* Generous bottom spacer. */}
          <div className="h-[42vh]" />

          {/* Subtle top/bottom masks so lines gracefully enter/exit. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/25 to-transparent" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/25 to-transparent" />

          {!isPlaying && (
            <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
              <span className="rounded-full bg-white/10 px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-white/80 backdrop-blur">
                Paused
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="scroll-thin flex-1 overflow-y-auto px-10 pb-10">
          <p className="mb-5 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Plain lyrics · not time-synced
          </p>
          <div className="whitespace-pre-wrap text-lg leading-relaxed text-foreground/85">
            {plain}
          </div>
        </div>
      )}
    </div>
  );
}

function ShellMsg({
  icon,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex h-full items-center justify-center px-10">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <div className="flex size-16 items-center justify-center rounded-full bg-white/5">
          {icon}
        </div>
        <p className="text-base font-semibold text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}

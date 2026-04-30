import { Library, Disc3, SlidersHorizontal, Infinity as InfinityIcon, Mic2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type View = "library" | "now-playing" | "lyrics" | "effects";

interface SidebarProps {
  view: View;
  onChange: (v: View) => void;
  /** Whether a track is currently playing — adds an indicator dot. */
  isPlaying?: boolean;
  /** Whether the Infinite Jukebox loop mode is active. */
  jukeboxActive?: boolean;
  onToggleJukebox?: () => void;
}

interface NavItem {
  id: View;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

const NAV: NavItem[] = [
  { id: "library",     label: "Library",     icon: Library },
  { id: "now-playing", label: "Now Playing", icon: Disc3 },
  { id: "lyrics",      label: "Lyrics",      icon: Mic2 },
  { id: "effects",     label: "Effects",     icon: SlidersHorizontal },
];

/**
 * Compact, unbranded sidebar. Just a nav column + the Infinite Jukebox
 * toggle. The app's product name never appears here — the OS window
 * title is the only place that lives.
 */
export function Sidebar({ view, onChange, isPlaying, jukeboxActive, onToggleJukebox }: SidebarProps) {
  return (
    <aside className="z-10 flex h-full w-[200px] shrink-0 flex-col gap-6 px-3 py-4">
      <nav className="flex flex-col gap-0.5 pt-2">
        {NAV.map((item) => {
          const active = view === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onChange(item.id)}
              className={cn(
                "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors",
                active
                  ? "bg-white/8 text-foreground"
                  : "text-muted-foreground hover:bg-white/4 hover:text-foreground",
              )}
            >
              <Icon size={16} className={cn(active && "text-primary")} />
              <span className="text-sm font-medium">{item.label}</span>
              {item.id === "now-playing" && isPlaying && (
                <span className="absolute right-3 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-primary shadow-[0_0_8px_rgba(0,229,255,0.55)]" />
              )}
            </button>
          );
        })}
      </nav>

      {/* Infinite Jukebox — optional feature toggle. Prominent card so it
          doesn't look like just another nav item. */}
      <JukeboxToggle active={!!jukeboxActive} onToggle={onToggleJukebox} />

      <div className="mt-auto" />
    </aside>
  );
}

function JukeboxToggle({ active, onToggle }: { active: boolean; onToggle?: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={cn(
        "group relative flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition-all",
        active
          ? "border-primary/40 bg-primary/10"
          : "border-white/6 bg-white/2 hover:border-white/12 hover:bg-white/4",
      )}
    >
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors",
          active
            ? "bg-primary/20 text-primary shadow-[0_0_20px_rgba(0,229,255,0.35)]"
            : "bg-white/5 text-muted-foreground group-hover:text-foreground",
        )}
      >
        <InfinityIcon size={14} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "text-[11px] font-semibold uppercase tracking-[0.14em]",
            active ? "text-primary" : "text-foreground",
          )}
        >
          Infinite Jukebox
        </span>
        <span className="truncate text-[10.5px] leading-tight text-muted-foreground">
          {active ? "Looping between similar beats" : "Tap to enable loop mode"}
        </span>
      </div>
      {/* Switch visual */}
      <span
        className={cn(
          "relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors",
          active ? "bg-primary" : "bg-white/10",
        )}
        aria-hidden
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 size-3 rounded-full bg-white shadow transition-transform",
            active ? "translate-x-3" : "translate-x-0",
          )}
        />
      </span>
    </button>
  );
}

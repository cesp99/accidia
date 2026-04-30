import { useState } from "react";
import {
  Library,
  Disc3,
  SlidersHorizontal,
  Infinity as InfinityIcon,
  Mic2,
  Heart,
  ListMusic,
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Playlist } from "@/hooks/use-playlists";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";

export type View =
  | "library"
  | "now-playing"
  | "lyrics"
  | "effects"
  | "favorites"
  | { type: "playlist"; id: string };

interface SidebarProps {
  view: View;
  onChange: (v: View) => void;
  /** Whether a track is currently playing — adds an indicator dot. */
  isPlaying?: boolean;
  /** Whether the Infinite Jukebox loop mode is active. */
  jukeboxActive?: boolean;
  onToggleJukebox?: () => void;

  // --- Collections ---
  favoritesCount: number;
  playlists: Playlist[];
  onNewPlaylist: () => void;
  onRenamePlaylist: (pl: Playlist) => void;
  onDeletePlaylist: (pl: Playlist) => void;
}

interface NavItem {
  id: Exclude<View, { type: "playlist"; id: string }>;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

const NAV: NavItem[] = [
  { id: "library", label: "Library", icon: Library },
  { id: "favorites", label: "Favorites", icon: Heart },
  { id: "now-playing", label: "Now Playing", icon: Disc3 },
  { id: "lyrics", label: "Lyrics", icon: Mic2 },
  { id: "effects", label: "Effects", icon: SlidersHorizontal },
];

/**
 * Sidebar with:
 *   - Core navigation (Library / Favorites / Now Playing / Lyrics / Effects)
 *   - Infinite Jukebox toggle
 *   - Playlists section with create + right-click rename/delete
 */
export function Sidebar({
  view,
  onChange,
  isPlaying,
  jukeboxActive,
  onToggleJukebox,
  favoritesCount,
  playlists,
  onNewPlaylist,
  onRenamePlaylist,
  onDeletePlaylist,
}: SidebarProps) {
  const currentPlaylistId = typeof view === "object" && view.type === "playlist" ? view.id : null;

  return (
    <aside className="z-10 flex h-full w-[220px] shrink-0 flex-col gap-5 px-3 py-4">
      <nav className="flex flex-col gap-0.5 pt-2">
        {NAV.map((item) => {
          const active = typeof view === "string" && view === item.id;
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
              <span className="flex-1 truncate text-sm font-medium">{item.label}</span>
              {item.id === "now-playing" && isPlaying && (
                <span className="size-1.5 rounded-full bg-primary shadow-[0_0_8px_rgba(0,229,255,0.55)]" />
              )}
              {item.id === "favorites" && favoritesCount > 0 && (
                <span className="text-[10px] font-mono tabular-nums text-muted-foreground/70">
                  {favoritesCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Infinite Jukebox toggle */}
      <JukeboxToggle active={!!jukeboxActive} onToggle={onToggleJukebox} />

      {/* Playlists */}
      <PlaylistsSection
        playlists={playlists}
        currentPlaylistId={currentPlaylistId}
        onOpen={(id) => onChange({ type: "playlist", id })}
        onCreate={onNewPlaylist}
        onRename={onRenamePlaylist}
        onDelete={onDeletePlaylist}
      />

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
          {active ? "Looping similar beats" : "Tap to enable loop mode"}
        </span>
      </div>
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

function PlaylistsSection({
  playlists,
  currentPlaylistId,
  onOpen,
  onCreate,
  onRename,
  onDelete,
}: {
  playlists: Playlist[];
  currentPlaylistId: string | null;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onRename: (pl: Playlist) => void;
  onDelete: (pl: Playlist) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 pb-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Playlists
        </p>
        <button
          type="button"
          onClick={onCreate}
          aria-label="New playlist"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-white/5 hover:text-foreground"
        >
          <Plus size={13} />
        </button>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {playlists.length === 0 ? (
          <div className="px-3 pb-2 text-[11px] text-muted-foreground/70">
            No playlists yet. Tap + to make one.
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {playlists.map((pl) => {
              const active = currentPlaylistId === pl.id;
              return (
                <li
                  key={pl.id}
                  onMouseEnter={() => setHovered(pl.id)}
                  onMouseLeave={() => setHovered(null)}
                >
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <button
                        type="button"
                        onClick={() => onOpen(pl.id)}
                        className={cn(
                          "group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors",
                          active
                            ? "bg-white/8 text-foreground"
                            : "text-muted-foreground hover:bg-white/4 hover:text-foreground",
                        )}
                      >
                        <ListMusic
                          size={14}
                          className={cn("shrink-0", active && "text-primary")}
                        />
                        <span className="flex-1 truncate text-[13px]">{pl.name}</span>
                        {hovered === pl.id ? (
                          <span
                            aria-hidden
                            className="text-muted-foreground/70"
                          >
                            <MoreHorizontal size={12} />
                          </span>
                        ) : (
                          pl.paths?.length ? (
                            <span className="text-[10px] font-mono tabular-nums text-muted-foreground/70">
                              {pl.paths.length}
                            </span>
                          ) : null
                        )}
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onSelect={() => onRename(pl)}>
                        <Pencil size={13} />
                        Rename
                      </ContextMenuItem>
                      <ContextMenuItem variant="destructive" onSelect={() => onDelete(pl)}>
                        <Trash2 size={13} />
                        Delete
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

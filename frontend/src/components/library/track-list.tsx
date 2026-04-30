import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Disc3, Heart, Play, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { store } from "../../../wailsjs/go/models";
import { GetCoverArt } from "../../../wailsjs/go/main/App";
import { TrackContextMenu } from "./track-context-menu";
import type { Playlist } from "@/hooks/use-playlists";

type Track = store.Track;

const COLLAPSED_STORAGE_KEY = "accidia.library.collapsedAlbums.v1";

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveCollapsed(keys: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(Array.from(keys)));
  } catch {
    // Private-browsing mode etc. — non-fatal.
  }
}

interface TrackListProps {
  tracks: Track[];
  currentPath?: string;
  onPlay: (track: Track, albumTracks: Track[], albumLabel: string) => void;
  onPlayNext: (tracks: Track[]) => void;
  onAddToQueue: (tracks: Track[]) => void;
  isFavorite: (path: string) => boolean;
  onToggleFavorite: (path: string) => void;
  playlists: Playlist[];
  onAddToPlaylist: (playlistId: string, paths: string[]) => void;
  onCreatePlaylistWithTracks: (paths: string[]) => void;
  /** When provided, the UI shows "Remove from playlist" in the context menu. */
  onRemoveFromPlaylist?: (paths: string[]) => void;
  removeFromPlaylistLabel?: string;
  /** Empty-state override (used by the Favorites / Playlist views). */
  emptyLabel?: string;
  emptySubtitle?: string;
  /** Hide the album-grouping and just show a flat list. */
  flat?: boolean;
  /** Pre-supply an overall "play all" source label (defaults to "Library"). */
  sourceLabel?: string;
  /** Main heading — defaults to "Library". */
  heading?: string;
  /** Hide the search box (useful in small / embedded views). */
  hideSearch?: boolean;
  /** Extra content to render alongside the heading (e.g. "Play all" button). */
  headerActions?: React.ReactNode;
}

interface AlbumGroup {
  key: string;
  album: string;
  artist: string;
  artwork?: string | null;
  tracks: Track[];
  // Path of any track in the album with cover art — used to fetch artwork.
  artworkSource?: string;
}

/**
 * Group consecutive tracks by (albumArtist|artist, album). Produces nice
 * album cards instead of a flat 4000-row list which is jarring even when
 * virtualized.
 */
function groupByAlbum(tracks: Track[]): AlbumGroup[] {
  const groups: AlbumGroup[] = [];
  let current: AlbumGroup | null = null;
  for (const t of tracks) {
    const albumKey = (t.album || "Unknown Album").trim();
    const artistKey = (t.albumArtist || t.artist || "Unknown Artist").trim();
    const groupKey = `${artistKey}::${albumKey}`;
    if (!current || current.key !== groupKey) {
      current = {
        key: groupKey,
        album: albumKey,
        artist: artistKey,
        tracks: [],
        artworkSource: t.hasCoverArt ? t.path : undefined,
      };
      groups.push(current);
    }
    if (!current.artworkSource && t.hasCoverArt) {
      current.artworkSource = t.path;
    }
    current.tracks.push(t);
  }
  return groups;
}

export function TrackList({
  tracks,
  currentPath,
  onPlay,
  onPlayNext,
  onAddToQueue,
  isFavorite,
  onToggleFavorite,
  playlists,
  onAddToPlaylist,
  onCreatePlaylistWithTracks,
  onRemoveFromPlaylist,
  removeFromPlaylistLabel,
  emptyLabel,
  emptySubtitle,
  flat = false,
  sourceLabel = "Library",
  heading = "Library",
  hideSearch = false,
  headerActions,
}: TrackListProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    if (!query.trim()) return tracks;
    const q = query.toLowerCase();
    return tracks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.artist?.toLowerCase().includes(q) ||
        t.album?.toLowerCase().includes(q),
    );
  }, [tracks, query]);

  const groups = useMemo(() => (flat ? [] : groupByAlbum(filtered)), [filtered, flat]);

  // Per-album collapse state, persisted so the user's choices survive
  // app restarts. A group key is in the set iff that album is collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed());
  useEffect(() => {
    saveCollapsed(collapsed);
  }, [collapsed]);

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // "Collapse all" marks every visible group as collapsed. The inverse
  // ("expand all") simply clears the persisted set — we don't need to
  // track expanded groups explicitly since "not in set" means expanded.
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed.has(g.key));
  const toggleAll = useCallback(() => {
    if (allCollapsed) {
      setCollapsed(new Set());
    } else {
      setCollapsed(new Set(groups.map((g) => g.key)));
    }
  }, [allCollapsed, groups]);

  const rowCommonProps = {
    isFavorite,
    onToggleFavorite,
    playlists,
    onPlayNext,
    onAddToQueue,
    onAddToPlaylist,
    onCreatePlaylistWithTracks,
    onRemoveFromPlaylist,
    removeFromPlaylistLabel,
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="px-6 pt-2 pb-4">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{heading}</h1>
          <div className="flex items-center gap-3">
            {headerActions}
            {!flat && groups.length > 1 && (
              <button
                type="button"
                onClick={toggleAll}
                className="text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                {allCollapsed ? "Expand all" : "Collapse all"}
              </button>
            )}
            <p className="text-xs tabular-nums text-muted-foreground">
              {tracks.length.toLocaleString()} track{tracks.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        {!hideSearch && (
          <div className="mt-3 flex items-center gap-2 rounded-full border border-white/8 bg-white/3 px-3.5 py-2 backdrop-blur">
            <Search size={13} className="text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search title, artist, album"
              className="flex-1 bg-transparent text-sm placeholder:text-muted-foreground/60 focus:outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                clear
              </button>
            )}
          </div>
        )}
      </header>
      <div className="scroll-thin flex-1 overflow-y-auto px-6 pb-6">
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
            {query ? (
              <p>No tracks match.</p>
            ) : (
              <div>
                <p className="font-medium text-foreground">{emptyLabel ?? "No tracks yet."}</p>
                {emptySubtitle && (
                  <p className="mt-1 text-xs text-muted-foreground">{emptySubtitle}</p>
                )}
              </div>
            )}
          </div>
        ) : flat ? (
          <ul className="rounded-xl border border-white/5 bg-white/[0.02] backdrop-blur-sm overflow-hidden">
            {filtered.map((t) => (
              <TrackRow
                key={t.path}
                track={t}
                groupArtist={""}
                currentPath={currentPath}
                onPlay={() => onPlay(t, filtered, sourceLabel)}
                {...rowCommonProps}
              />
            ))}
          </ul>
        ) : (
          <div className="space-y-6">
            {groups.map((g) => (
              <AlbumGroupCard
                key={g.key}
                group={g}
                currentPath={currentPath}
                collapsed={collapsed.has(g.key)}
                onToggleCollapsed={() => toggleCollapsed(g.key)}
                onPlay={(t) => onPlay(t, g.tracks, `${g.album} · ${g.artist}`)}
                onPlayAlbum={() =>
                  onPlay(g.tracks[0], g.tracks, `${g.album} · ${g.artist}`)
                }
                {...rowCommonProps}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface RowCommonProps {
  isFavorite: (path: string) => boolean;
  onToggleFavorite: (path: string) => void;
  playlists: Playlist[];
  onPlayNext: (tracks: Track[]) => void;
  onAddToQueue: (tracks: Track[]) => void;
  onAddToPlaylist: (playlistId: string, paths: string[]) => void;
  onCreatePlaylistWithTracks: (paths: string[]) => void;
  onRemoveFromPlaylist?: (paths: string[]) => void;
  removeFromPlaylistLabel?: string;
}

function AlbumGroupCard({
  group,
  currentPath,
  collapsed,
  onToggleCollapsed,
  onPlay,
  onPlayAlbum,
  ...common
}: {
  group: AlbumGroup;
  currentPath?: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onPlay: (track: Track) => void;
  onPlayAlbum: () => void;
} & RowCommonProps) {
  const [artwork, setArtwork] = useState<string | null>(null);
  const requested = useRef(false);

  useEffect(() => {
    if (requested.current || !group.artworkSource) return;
    requested.current = true;
    let cancelled = false;
    GetCoverArt(group.artworkSource).then((url) => {
      if (!cancelled) setArtwork(url || null);
    });
    return () => {
      cancelled = true;
    };
  }, [group.artworkSource]);

  // If the current track belongs to this album, keep it visible even
  // when the user had previously collapsed the card — it's disorienting
  // to not see what's playing. We don't mutate the persisted state here,
  // just override the visual for this render.
  const currentTrackHere = currentPath
    ? group.tracks.some((t) => t.path === currentPath)
    : false;
  const effectivelyCollapsed = collapsed && !currentTrackHere;

  return (
    <section className="group">
      <div className="flex items-center gap-4 pb-3">
        <button
          type="button"
          onClick={onPlayAlbum}
          aria-label={`Play ${group.album}`}
          className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md border border-white/10 bg-card shadow-md group/art"
        >
          {artwork ? (
            <img src={artwork} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <Disc3 size={24} className="text-muted-foreground/40" />
            </div>
          )}
          <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover/art:opacity-100">
            <Play size={18} fill="currentColor" className="text-white" />
          </span>
        </button>
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!effectivelyCollapsed}
          className={cn(
            "group/header flex min-w-0 flex-1 items-center gap-3 rounded-md px-1 py-1 -mx-1 text-left",
            "transition-colors hover:bg-white/3",
          )}
        >
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-foreground">
              {group.album}
            </h2>
            <p className="truncate text-sm text-muted-foreground">{group.artist}</p>
            <p className="text-[11px] text-muted-foreground/70">
              {group.tracks.length} track{group.tracks.length === 1 ? "" : "s"}
            </p>
          </div>
          <span
            aria-hidden
            className={cn(
              "shrink-0 text-muted-foreground/70 transition-transform duration-200 ease-out",
              "group-hover/header:text-foreground",
              effectivelyCollapsed ? "-rotate-90" : "rotate-0",
            )}
          >
            <ChevronDown size={16} />
          </span>
        </button>
      </div>
      {!effectivelyCollapsed && (
        <ul className="rounded-xl border border-white/5 bg-white/[0.02] backdrop-blur-sm overflow-hidden">
          {group.tracks.map((t) => (
            <TrackRow
              key={t.path}
              track={t}
              groupArtist={group.artist}
              currentPath={currentPath}
              onPlay={() => onPlay(t)}
              {...common}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function TrackRow({
  track,
  groupArtist,
  currentPath,
  onPlay,
  isFavorite,
  onToggleFavorite,
  playlists,
  onPlayNext,
  onAddToQueue,
  onAddToPlaylist,
  onCreatePlaylistWithTracks,
  onRemoveFromPlaylist,
  removeFromPlaylistLabel,
}: {
  track: Track;
  groupArtist: string;
  currentPath?: string;
  onPlay: () => void;
} & RowCommonProps) {
  const isCurrent = track.path === currentPath;
  const fav = isFavorite(track.path);
  return (
    <TrackContextMenu
      track={track}
      isFavorite={fav}
      playlists={playlists}
      onPlay={onPlay}
      onPlayNext={() => onPlayNext([track])}
      onAddToQueue={() => onAddToQueue([track])}
      onToggleFavorite={() => onToggleFavorite(track.path)}
      onAddToPlaylist={(id) => onAddToPlaylist(id, [track.path])}
      onCreatePlaylistWithTrack={() => onCreatePlaylistWithTracks([track.path])}
      onRemoveFromPlaylist={
        onRemoveFromPlaylist ? () => onRemoveFromPlaylist([track.path]) : undefined
      }
      removeFromPlaylistLabel={removeFromPlaylistLabel}
    >
      <li
        className={cn(
          "group/row flex items-center gap-3 px-3 py-2 text-sm",
          "border-b border-white/5 last:border-b-0",
          "transition-colors hover:bg-white/4 cursor-pointer",
          isCurrent && "bg-primary/8",
        )}
        onDoubleClick={onPlay}
      >
        <button
          type="button"
          onClick={onPlay}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
            "transition-all",
            isCurrent
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:bg-white/8 hover:text-foreground",
          )}
          aria-label={`Play ${track.title}`}
        >
          <Play size={12} fill="currentColor" className="ml-0.5" />
        </button>
        <span
          className={cn(
            "w-6 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground/70",
            isCurrent && "text-primary",
            "group-hover/row:opacity-0",
          )}
          style={{ marginLeft: "-1.75rem" }}
        >
          {track.trackNumber || "—"}
        </span>
        <div className="min-w-0 flex-1">
          <p className={cn("truncate", isCurrent && "text-primary font-medium")}>{track.title}</p>
          {track.artist && track.artist !== groupArtist && (
            <p className="truncate text-xs text-muted-foreground">{track.artist}</p>
          )}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(track.path);
          }}
          aria-label={fav ? "Remove from favorites" : "Add to favorites"}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-full transition-colors",
            fav
              ? "text-primary opacity-100"
              : "text-muted-foreground opacity-0 hover:bg-white/8 hover:text-foreground group-hover/row:opacity-100 focus:opacity-100",
          )}
        >
          <Heart size={12} fill={fav ? "currentColor" : "none"} strokeWidth={fav ? 0 : 2} />
        </button>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
          {track.format || ""}
        </span>
      </li>
    </TrackContextMenu>
  );
}

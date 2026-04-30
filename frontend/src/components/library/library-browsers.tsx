import { useMemo, useState } from "react";
import { Disc3, Play, Search, Shuffle, User } from "lucide-react";
import { cn } from "@/lib/utils";
import type { store } from "../../../wailsjs/go/models";
import { useCoverArt } from "@/lib/cover-cache";

type Track = store.Track;

// ---------------------------------------------------------------------------
// Grouping helpers
// ---------------------------------------------------------------------------

export interface AlbumGroup {
  key: string;
  album: string;
  artist: string;
  tracks: Track[];
  /** Path of the first track in the album that has embedded art, if any. */
  artworkSource?: string;
}

export interface ArtistGroup {
  name: string;
  tracks: Track[];
  /** Set of distinct album titles under this artist. */
  albumCount: number;
  /** Path of any track with embedded cover art we can use as a thumbnail. */
  artworkSource?: string;
}

// Separators commonly found inside multi-artist tags. We match on a
// single occurrence so "Daft Punk, Julian Casablancas" yields "Daft Punk"
// as the primary artist. The " & " / " x " / " with " variants require
// surrounding whitespace to avoid chewing into legitimate names like
// "B&B" or "Sixx:A.M.".
const ARTIST_SPLIT_RE = /\s*(?:,|;|\/| & | feat\. | featuring | ft\. | x | with )\s*/i;

/** First artist token in a potentially multi-artist string. */
export function primaryArtist(name: string): string {
  const trimmed = (name || "").trim();
  if (!trimmed) return "";
  const idx = trimmed.search(ARTIST_SPLIT_RE);
  return idx < 0 ? trimmed : trimmed.slice(0, idx).trim();
}

/**
 * Album identity used for grouping. Two tracks with the same (trimmed,
 * case-insensitive) album title belong to the same album regardless of
 * which featuring artists happen to be credited on each track — matching
 * how users think about albums like "Random Access Memories" (Daft Punk)
 * whose guest-heavy tracklist would otherwise fan out into many cards.
 *
 * Tracks without an album tag fall back to a per-artist "Unknown Album"
 * bucket so we don't collapse unrelated loose files into a single blob.
 */
function albumIdentityKey(t: Track): string {
  const album = (t.album || "").trim();
  if (album) return `album:${album.toLowerCase()}`;
  const artist = (t.albumArtist || t.artist || "Unknown Artist").trim();
  return `unknown:${artist.toLowerCase()}`;
}

/**
 * Group tracks into albums by album title (case-insensitive). The display
 * artist is resolved to the primary artist shared by most tracks — for
 * an album full of "Daft Punk, $guest" credits that collapses to plain
 * "Daft Punk". Genuine compilations where every track has a distinct
 * primary artist render as "Various Artists".
 */
export function groupByAlbum(tracks: Track[]): AlbumGroup[] {
  const byKey = new Map<string, AlbumGroup>();
  // Per-group tally of primary-artist → count, used to pick a stable
  // display artist for the whole album instead of whichever track we
  // happened to visit first.
  const primaryCounts = new Map<string, Map<string, number>>();

  for (const t of tracks) {
    const key = albumIdentityKey(t);
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        album: (t.album || "Unknown Album").trim(),
        artist: "",
        tracks: [],
        artworkSource: t.hasCoverArt ? t.path : undefined,
      };
      byKey.set(key, g);
      primaryCounts.set(key, new Map());
    }
    if (!g.artworkSource && t.hasCoverArt) g.artworkSource = t.path;
    g.tracks.push(t);
    const primary = primaryArtist(t.albumArtist || t.artist || "") || "Unknown Artist";
    const counts = primaryCounts.get(key)!;
    counts.set(primary, (counts.get(primary) || 0) + 1);
  }

  for (const [key, g] of byKey) {
    const counts = primaryCounts.get(key)!;
    let best = "Unknown Artist";
    let bestCount = 0;
    for (const [name, c] of counts) {
      if (c > bestCount) {
        best = name;
        bestCount = c;
      }
    }
    // If every track has a unique primary artist (and there's more than
    // one track), this is a compilation — label it accordingly.
    g.artist = counts.size === g.tracks.length && g.tracks.length > 1
      ? "Various Artists"
      : best;
  }

  return Array.from(byKey.values()).sort(
    (a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album),
  );
}

/**
 * Group by artist (preferring albumArtist when set). Unlike groupByAlbum
 * this is an O(n) pass over the full track list — we need all tracks per
 * artist, not just consecutive runs.
 */
export function groupByArtist(tracks: Track[]): ArtistGroup[] {
  const byName = new Map<string, ArtistGroup>();
  for (const t of tracks) {
    const name = (t.albumArtist || t.artist || "Unknown Artist").trim();
    let g = byName.get(name);
    if (!g) {
      g = {
        name,
        tracks: [],
        albumCount: 0,
        artworkSource: t.hasCoverArt ? t.path : undefined,
      };
      byName.set(name, g);
    }
    if (!g.artworkSource && t.hasCoverArt) g.artworkSource = t.path;
    g.tracks.push(t);
  }
  // Count distinct albums per artist.
  for (const g of byName.values()) {
    const albums = new Set<string>();
    for (const t of g.tracks) albums.add((t.album || "Unknown Album").trim());
    g.albumCount = albums.size;
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// Cover-art fetching now lives in `@/lib/cover-cache` so it's shared
// across every component that displays album/artist art (this file plus
// track-list's AlbumGroupCard plus App.tsx's pre-warm). That single
// cache is what lets us hit "Albums" → "All" → "Albums" without a
// fresh IPC roundtrip per card.

// ---------------------------------------------------------------------------
// AlbumsGrid — tile view of the library grouped by album
// ---------------------------------------------------------------------------

interface AlbumsGridProps {
  tracks: Track[];
  /**
   * Pre-computed album groups. When provided we skip the local
   * `groupByAlbum(tracks)` pass entirely — the parent already memoised
   * the result against a stable libraryTracks reference. The legacy
   * code path (computing on mount) is still here as a fallback for any
   * caller that hasn't migrated yet.
   */
  groups?: AlbumGroup[];
  onSelect: (album: AlbumGroup) => void;
  onPlay: (album: AlbumGroup) => void;
  onShuffle: (album: AlbumGroup) => void;
}

export function AlbumsGrid({ tracks, groups: providedGroups, onSelect, onPlay, onShuffle }: AlbumsGridProps) {
  const [query, setQuery] = useState("");
  const groups = useMemo(
    () => providedGroups ?? groupByAlbum(tracks),
    [providedGroups, tracks],
  );
  const filtered = useMemo(() => {
    if (!query.trim()) return groups;
    const q = query.toLowerCase();
    return groups.filter(
      (g) =>
        g.album.toLowerCase().includes(q) ||
        g.artist.toLowerCase().includes(q),
    );
  }, [groups, query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SearchBar
        query={query}
        onChange={setQuery}
        placeholder="Search albums or artist"
        summary={`${groups.length.toLocaleString()} album${groups.length === 1 ? "" : "s"}`}
      />
      <div className="scroll-thin flex-1 overflow-y-auto px-6 pb-6">
        {filtered.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            {query ? "No albums match." : "No albums in your library."}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-5">
            {filtered.map((g) => (
              <AlbumCard
                key={g.key}
                group={g}
                onOpen={() => onSelect(g)}
                onPlay={() => onPlay(g)}
                onShuffle={() => onShuffle(g)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AlbumCard({
  group,
  onOpen,
  onPlay,
  onShuffle,
}: {
  group: AlbumGroup;
  onOpen: () => void;
  onPlay: () => void;
  onShuffle: () => void;
}) {
  const art = useCoverArt(group.artworkSource);
  return (
    <div className="group/card flex flex-col gap-2">
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "relative aspect-square w-full overflow-hidden rounded-xl border border-white/8 bg-white/[0.03]",
          "transition-all hover:border-white/18",
        )}
        aria-label={`Open ${group.album}`}
      >
        {art ? (
          <img src={art} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-white/[0.03]">
            <Disc3 size={40} className="text-muted-foreground/40" />
          </div>
        )}
        {/* Hover overlay: play + shuffle */}
        <div className="pointer-events-none absolute inset-0 flex items-end justify-end gap-2 bg-gradient-to-t from-black/50 via-black/10 to-transparent p-3 opacity-0 transition-opacity group-hover/card:opacity-100">
          <HoverAction
            label="Shuffle"
            onClick={(e) => {
              e.stopPropagation();
              onShuffle();
            }}
          >
            <Shuffle size={13} />
          </HoverAction>
          <HoverAction
            label="Play"
            primary
            onClick={(e) => {
              e.stopPropagation();
              onPlay();
            }}
          >
            <Play size={13} fill="currentColor" className="ml-0.5" />
          </HoverAction>
        </div>
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 text-left"
      >
        <p className="truncate text-sm font-semibold text-foreground">{group.album}</p>
        <p className="truncate text-xs text-muted-foreground">{group.artist}</p>
        <p className="text-[10px] font-mono tabular-nums text-muted-foreground/70">
          {group.tracks.length} track{group.tracks.length === 1 ? "" : "s"}
        </p>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ArtistsList — list of artists with a round thumbnail
// ---------------------------------------------------------------------------

interface ArtistsListProps {
  tracks: Track[];
  /** Pre-computed artist groups (see AlbumsGridProps for rationale). */
  groups?: ArtistGroup[];
  onSelect: (artist: ArtistGroup) => void;
  onPlay: (artist: ArtistGroup) => void;
  onShuffle: (artist: ArtistGroup) => void;
}

export function ArtistsList({ tracks, groups: providedGroups, onSelect, onPlay, onShuffle }: ArtistsListProps) {
  const [query, setQuery] = useState("");
  const groups = useMemo(
    () => providedGroups ?? groupByArtist(tracks),
    [providedGroups, tracks],
  );
  const filtered = useMemo(() => {
    if (!query.trim()) return groups;
    const q = query.toLowerCase();
    return groups.filter((g) => g.name.toLowerCase().includes(q));
  }, [groups, query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SearchBar
        query={query}
        onChange={setQuery}
        placeholder="Search artists"
        summary={`${groups.length.toLocaleString()} artist${groups.length === 1 ? "" : "s"}`}
      />
      <div className="scroll-thin flex-1 overflow-y-auto px-6 pb-6">
        {filtered.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            {query ? "No artists match." : "No artists in your library."}
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-white/5 overflow-hidden rounded-xl border border-white/5 bg-white/[0.02]">
            {filtered.map((g) => (
              <ArtistRow
                key={g.name}
                group={g}
                onOpen={() => onSelect(g)}
                onPlay={() => onPlay(g)}
                onShuffle={() => onShuffle(g)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ArtistRow({
  group,
  onOpen,
  onPlay,
  onShuffle,
}: {
  group: ArtistGroup;
  onOpen: () => void;
  onPlay: () => void;
  onShuffle: () => void;
}) {
  const art = useCoverArt(group.artworkSource);
  return (
    <li className="group/row flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-white/3">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <div className="size-11 shrink-0 overflow-hidden rounded-full border border-white/10 bg-white/[0.04]">
          {art ? (
            <img src={art} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <User size={16} className="text-muted-foreground/50" />
            </div>
          )}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{group.name}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {group.tracks.length} track{group.tracks.length === 1 ? "" : "s"}
            {" · "}
            {group.albumCount} album{group.albumCount === 1 ? "" : "s"}
          </p>
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          onClick={onShuffle}
          aria-label={`Shuffle ${group.name}`}
          className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-white/8 hover:text-foreground"
        >
          <Shuffle size={13} />
        </button>
        <button
          type="button"
          onClick={onPlay}
          aria-label={`Play ${group.name}`}
          className="flex size-8 items-center justify-center rounded-full bg-white text-black hover:brightness-95"
        >
          <Play size={13} fill="currentColor" className="ml-0.5" />
        </button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Shared little bits
// ---------------------------------------------------------------------------

function SearchBar({
  query,
  onChange,
  placeholder,
  summary,
}: {
  query: string;
  onChange: (v: string) => void;
  placeholder: string;
  summary: string;
}) {
  return (
    <div className="px-6 pt-2 pb-4">
      <div className="flex items-baseline justify-between gap-4 pb-3">
        <p className="text-xs tabular-nums text-muted-foreground">{summary}</p>
      </div>
      <div className="flex items-center gap-2 rounded-full border border-white/8 bg-white/3 px-3.5 py-2 backdrop-blur">
        <Search size={13} className="text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="flex-1 bg-transparent text-sm placeholder:text-muted-foreground/60 focus:outline-none"
        />
        {query && (
          <button
            type="button"
            onClick={() => onChange("")}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            clear
          </button>
        )}
      </div>
    </div>
  );
}

function HoverAction({
  primary = false,
  onClick,
  label,
  children,
}: {
  primary?: boolean;
  onClick: (e: React.MouseEvent) => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        "pointer-events-auto flex size-9 items-center justify-center rounded-full",
        "shadow-[0_4px_14px_rgba(0,0,0,0.45)]",
        primary
          ? "bg-white text-black hover:brightness-95"
          : "bg-black/40 text-white backdrop-blur hover:bg-black/55",
      )}
    >
      {children}
    </button>
  );
}

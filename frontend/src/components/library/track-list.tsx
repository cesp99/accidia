import { useEffect, useMemo, useRef, useState } from "react";
import { Disc3, Play, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { main } from "../../../wailsjs/go/models";
import { GetCoverArt } from "../../../wailsjs/go/main/App";

type Track = main.Track;

interface TrackListProps {
  tracks: Track[];
  currentPath?: string;
  onPlay: (track: Track) => void;
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

export function TrackList({ tracks, currentPath, onPlay }: TrackListProps) {
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

  const groups = useMemo(() => groupByAlbum(filtered), [filtered]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="px-6 pt-2 pb-4">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Library</h1>
          <p className="text-xs tabular-nums text-muted-foreground">
            {tracks.length.toLocaleString()} track{tracks.length === 1 ? "" : "s"}
          </p>
        </div>
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
      </header>
      <div className="scroll-thin flex-1 overflow-y-auto px-6 pb-6">
        {groups.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No tracks match.
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map((g) => (
              <AlbumGroupCard
                key={g.key}
                group={g}
                currentPath={currentPath}
                onPlay={onPlay}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AlbumGroupCard({
  group,
  currentPath,
  onPlay,
}: {
  group: AlbumGroup;
  currentPath?: string;
  onPlay: (track: Track) => void;
}) {
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

  return (
    <section className="group">
      <div className="flex items-center gap-4 pb-3">
        <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md border border-white/10 bg-card shadow-md">
          {artwork ? (
            <img src={artwork} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <Disc3 size={24} className="text-muted-foreground/40" />
            </div>
          )}
        </div>
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-foreground">{group.album}</h2>
          <p className="truncate text-sm text-muted-foreground">{group.artist}</p>
          <p className="text-[11px] text-muted-foreground/70">
            {group.tracks.length} track{group.tracks.length === 1 ? "" : "s"}
          </p>
        </div>
      </div>
      <ul className="rounded-xl border border-white/5 bg-white/[0.02] backdrop-blur-sm overflow-hidden">
        {group.tracks.map((t) => {
          const isCurrent = t.path === currentPath;
          return (
            <li
              key={t.path}
              className={cn(
                "group/row flex items-center gap-3 px-3 py-2 text-sm",
                "border-b border-white/5 last:border-b-0",
                "transition-colors hover:bg-white/4 cursor-pointer",
                isCurrent && "bg-primary/8",
              )}
              onDoubleClick={() => onPlay(t)}
            >
              <button
                type="button"
                onClick={() => onPlay(t)}
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                  "transition-all",
                  isCurrent
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:bg-white/8 hover:text-foreground",
                )}
                aria-label={`Play ${t.title}`}
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
                {t.trackNumber || "—"}
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn("truncate", isCurrent && "text-primary font-medium")}>{t.title}</p>
                {t.artist && t.artist !== group.artist && (
                  <p className="truncate text-xs text-muted-foreground">{t.artist}</p>
                )}
              </div>
              <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
                {t.format || ""}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

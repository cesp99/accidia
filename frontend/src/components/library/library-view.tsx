import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  FolderOpen,
  LayoutGrid,
  List,
  Loader2,
  Music2,
  Play,
  Shuffle,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TrackList } from "./track-list";
import {
  AlbumsGrid,
  ArtistsList,
  groupByAlbum,
  groupByArtist,
  type AlbumGroup,
  type ArtistGroup,
} from "./library-browsers";
import {
  GetLibrary,
  PickLibraryFolder,
  ScanLibrary,
} from "../../../wailsjs/go/main/App";
import { EventsOn } from "../../../wailsjs/runtime/runtime";
import type { store } from "../../../wailsjs/go/models";
import type { Playlist } from "@/hooks/use-playlists";

type Track = store.Track;

// ---------------------------------------------------------------------------
// View-mode helpers
// ---------------------------------------------------------------------------

type Mode = "all" | "albums" | "artists";

type Drill =
  | { type: "album"; key: string }
  | { type: "artist"; name: string }
  | null;

const MODE_STORAGE_KEY = "accidia.library.mode.v1";

function loadMode(): Mode {
  try {
    const raw = localStorage.getItem(MODE_STORAGE_KEY);
    if (raw === "albums" || raw === "artists" || raw === "all") return raw;
  } catch {
    /* non-fatal */
  }
  return "all";
}

function saveMode(mode: Mode) {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    /* non-fatal */
  }
}

// ---------------------------------------------------------------------------
// LibraryView — the big one
// ---------------------------------------------------------------------------

interface LibraryViewProps {
  currentPath?: string;
  onPlay: (track: Track, albumTracks: Track[], albumLabel: string) => void;
  onShufflePlay: (tracks: Track[], label: string) => void;
  onPlayNext: (tracks: Track[]) => void;
  onAddToQueue: (tracks: Track[]) => void;
  isFavorite: (path: string) => boolean;
  onToggleFavorite: (path: string) => void;
  playlists: Playlist[];
  onAddToPlaylist: (playlistId: string, paths: string[]) => void;
  onCreatePlaylistWithTracks: (paths: string[]) => void;
  /** Hoisted so parent components can join against favorites / playlists. */
  onLibraryLoad?: (library: store.LibraryScanResult) => void;
  /**
   * Precomputed album/artist groupings owned by the parent (App.tsx).
   * Memoised against a stable libraryTracks reference so they only
   * change on rescan or folder swap — switching between "all" /
   * "albums" / "artists" reuses the same buckets, eliminating the
   * per-tab `groupBy` cost on big libraries.
   */
  albumGroups?: AlbumGroup[];
  artistGroups?: ArtistGroup[];
}

interface ScanProgress {
  label: string;
  scanned: number;
  total: number;
}

export function LibraryView({
  currentPath,
  onPlay,
  onShufflePlay,
  onPlayNext,
  onAddToQueue,
  isFavorite,
  onToggleFavorite,
  playlists,
  onAddToPlaylist,
  onCreatePlaylistWithTracks,
  onLibraryLoad,
  albumGroups,
  artistGroups,
}: LibraryViewProps) {
  const [library, setLibrary] = useState<store.LibraryScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setModeState] = useState<Mode>(() => loadMode());
  const [drill, setDrill] = useState<Drill>(null);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    setDrill(null); // mode switch always clears the drill-down
    saveMode(m);
  }, []);

  // Initial load: pull whatever's cached on disk so the UI fills instantly.
  useEffect(() => {
    GetLibrary()
      .then((res) => {
        setLibrary(res);
        onLibraryLoad?.(res);
      })
      .catch((e) => setError(String(e)));
    // onLibraryLoad is expected to be stable; only fire on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to scan progress events emitted by Go's library scanner.
  useEffect(() => {
    return EventsOn("library:progress", (...args: unknown[]) => {
      const data = args[0] as ScanProgress;
      setProgress(data);
    });
  }, []);

  const handlePickFolder = async () => {
    setError(null);
    try {
      const path = await PickLibraryFolder();
      if (!path) return; // user cancelled
      setScanning(true);
      const result = await ScanLibrary(path);
      setLibrary(result);
      onLibraryLoad?.(result);
      setDrill(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
      setProgress(null);
    }
  };

  const handleRescan = async () => {
    if (!library?.root) return;
    setError(null);
    setScanning(true);
    try {
      const result = await ScanLibrary(library.root);
      setLibrary(result);
      onLibraryLoad?.(result);
      setDrill(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
      setProgress(null);
    }
  };

  const tracks = library?.tracks ?? [];

  // Prefer the parent's pre-memoised groupings when they line up with
  // our local library state (i.e. the parent already saw our latest
  // onLibraryLoad). Falling back to a local `groupByAlbum`/`groupByArtist`
  // pass keeps this component usable in isolation.
  const effectiveAlbumGroups = useMemo<AlbumGroup[]>(() => {
    if (albumGroups && albumGroups.length > 0) return albumGroups;
    if (tracks.length === 0) return [];
    return groupByAlbum(tracks);
  }, [albumGroups, tracks]);
  const effectiveArtistGroups = useMemo<ArtistGroup[]>(() => {
    if (artistGroups && artistGroups.length > 0) return artistGroups;
    if (tracks.length === 0) return [];
    return groupByArtist(tracks);
  }, [artistGroups, tracks]);

  // Resolve the drilled-down bucket from the full group list. Computed
  // unconditionally (rules-of-hooks) — returns null when no drill is
  // active or when the library hasn't been loaded yet.
  const drilledAlbum = useMemo<AlbumGroup | null>(() => {
    if (drill?.type !== "album" || effectiveAlbumGroups.length === 0) return null;
    return effectiveAlbumGroups.find((g) => g.key === drill.key) ?? null;
  }, [drill, effectiveAlbumGroups]);

  const drilledArtist = useMemo<ArtistGroup | null>(() => {
    if (drill?.type !== "artist" || effectiveArtistGroups.length === 0) return null;
    return effectiveArtistGroups.find((g) => g.name === drill.name) ?? null;
  }, [drill, effectiveArtistGroups]);

  if (!library || tracks.length === 0) {
    return (
      <Welcome
        onPickFolder={handlePickFolder}
        scanning={scanning}
        progress={progress}
        error={error}
      />
    );
  }

  // ---- Common row/list props piped into TrackList ----------------------
  const rowCommon = {
    isFavorite,
    onToggleFavorite,
    playlists,
    onAddToPlaylist,
    onCreatePlaylistWithTracks,
    onPlayNext,
    onAddToQueue,
  };

  // ---- Body: branches on drill-down > mode ----------------------------
  const body = (() => {
    if (drilledAlbum) {
      const label = `${drilledAlbum.album} · ${drilledAlbum.artist}`;
      return (
        <TrackList
          heading={drilledAlbum.album}
          tracks={drilledAlbum.tracks}
          currentPath={currentPath}
          onPlay={(t) => onPlay(t, drilledAlbum.tracks, label)}
          headerActions={
            <PlayShuffleButtons
              onPlay={() => onPlay(drilledAlbum.tracks[0], drilledAlbum.tracks, label)}
              onShuffle={() => onShufflePlay(drilledAlbum.tracks, label)}
            />
          }
          flat
          sourceLabel={label}
          hideSearch
          {...rowCommon}
        />
      );
    }
    if (drilledArtist) {
      const label = `Artist: ${drilledArtist.name}`;
      return (
        <TrackList
          heading={drilledArtist.name}
          tracks={drilledArtist.tracks}
          currentPath={currentPath}
          onPlay={(t, albumTracks, albumLabel) => onPlay(t, albumTracks, albumLabel)}
          headerActions={
            <PlayShuffleButtons
              onPlay={() =>
                onPlay(drilledArtist.tracks[0], drilledArtist.tracks, label)
              }
              onShuffle={() => onShufflePlay(drilledArtist.tracks, label)}
            />
          }
          sourceLabel={label}
          {...rowCommon}
        />
      );
    }
    if (mode === "albums") {
      return (
        <AlbumsGrid
          tracks={tracks}
          groups={effectiveAlbumGroups}
          onSelect={(g) => setDrill({ type: "album", key: g.key })}
          onPlay={(g) => onPlay(g.tracks[0], g.tracks, `${g.album} · ${g.artist}`)}
          onShuffle={(g) => onShufflePlay(g.tracks, `${g.album} · ${g.artist}`)}
        />
      );
    }
    if (mode === "artists") {
      return (
        <ArtistsList
          tracks={tracks}
          groups={effectiveArtistGroups}
          onSelect={(g) => setDrill({ type: "artist", name: g.name })}
          onPlay={(g) => onPlay(g.tracks[0], g.tracks, `Artist: ${g.name}`)}
          onShuffle={(g) => onShufflePlay(g.tracks, `Artist: ${g.name}`)}
        />
      );
    }
    // mode === "all"
    return (
      <TrackList
        heading="Library"
        tracks={tracks}
        groups={effectiveAlbumGroups}
        currentPath={currentPath}
        onPlay={onPlay}
        headerActions={
          <PlayShuffleButtons
            onPlay={() => onPlay(tracks[0], tracks, "Library")}
            onShuffle={() => onShufflePlay(tracks, "Library")}
            compact
          />
        }
        sourceLabel="Library"
        {...rowCommon}
      />
    );
  })();

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Folder strip + view-mode switcher. When drilled-down we hide
          the mode switcher and show a back button instead. */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-4">
        <div className="flex min-w-0 items-center gap-3">
          {drill ? (
            <button
              type="button"
              onClick={() => setDrill(null)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs",
                "text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground",
              )}
            >
              <ArrowLeft size={13} />
              {drill.type === "album" ? "Albums" : "Artists"}
            </button>
          ) : (
            <ModeSwitcher mode={mode} onChange={setMode} />
          )}
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex min-w-0 flex-col text-right">
            <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Music folder
            </p>
            <p className="truncate font-mono text-xs text-foreground/70">{library.root}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={handleRescan}
              disabled={scanning}
              className={cn(
                "rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-muted-foreground",
                "transition-colors hover:bg-white/10 hover:text-foreground",
                "disabled:opacity-50",
              )}
            >
              {scanning ? "Rescanning…" : "Rescan"}
            </button>
            <button
              type="button"
              onClick={handlePickFolder}
              disabled={scanning}
              className={cn(
                "rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-muted-foreground",
                "transition-colors hover:bg-white/10 hover:text-foreground",
                "disabled:opacity-50",
              )}
            >
              Change folder
            </button>
          </div>
        </div>
      </div>
      {scanning && progress && <ScanBar progress={progress} />}
      {error && <p className="px-6 pt-2 text-xs text-destructive">{error}</p>}
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mode switcher (segmented control)
// ---------------------------------------------------------------------------

function ModeSwitcher({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
}) {
  const opts: Array<{ id: Mode; label: string; icon: React.ComponentType<{ size?: number }> }> = [
    { id: "all", label: "All", icon: List },
    { id: "albums", label: "Albums", icon: LayoutGrid },
    { id: "artists", label: "Artists", icon: User },
  ];
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full border border-white/8 bg-white/3 p-0.5">
      {opts.map((o) => {
        const active = mode === o.id;
        const Icon = o.icon;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            aria-pressed={active}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition-colors",
              active
                ? "bg-white text-black"
                : "text-muted-foreground hover:bg-white/6 hover:text-foreground",
            )}
          >
            <Icon size={13} />
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Play + Shuffle buttons (shared between drill views + all-mode header)
// ---------------------------------------------------------------------------

function PlayShuffleButtons({
  onPlay,
  onShuffle,
  compact = false,
}: {
  onPlay: () => void;
  onShuffle: () => void;
  compact?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onShuffle}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs",
          "text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground",
        )}
      >
        <Shuffle size={11} />
        {compact ? "Shuffle" : "Shuffle"}
      </button>
      <button
        type="button"
        onClick={onPlay}
        className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-xs font-semibold text-black hover:brightness-95 active:scale-95"
      >
        <Play size={11} fill="currentColor" />
        Play
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scan progress bar
// ---------------------------------------------------------------------------

function ScanBar({ progress }: { progress: ScanProgress }) {
  const pct = progress.total > 0 ? (progress.scanned / progress.total) * 100 : 0;
  return (
    <div className="px-6 pt-3">
      <div className="rounded-lg border border-white/10 bg-white/5 p-3">
        <div className="flex items-center gap-2 text-xs text-foreground">
          <Loader2 size={12} className="animate-spin" />
          <span className="font-medium">{progress.label}</span>
          <span className="ml-auto font-mono tabular-nums text-muted-foreground">
            {progress.scanned}/{progress.total || "?"}
          </span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/8">
          <div
            className="h-full bg-white transition-[width] duration-100"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Welcome (empty state)
// ---------------------------------------------------------------------------

function Welcome({
  onPickFolder,
  scanning,
  progress,
  error,
}: {
  onPickFolder: () => void;
  scanning: boolean;
  progress: ScanProgress | null;
  error: string | null;
}) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="w-full max-w-md space-y-8 text-center animate-fade-in">
        <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-white/5">
          <Music2 size={26} className="text-foreground/80" />
        </div>
        <div className="space-y-3">
          <h1 className="text-3xl font-bold tracking-tight text-balance">
            Your music, beautifully.
          </h1>
          <p className="mx-auto max-w-sm text-sm leading-relaxed text-muted-foreground">
            Point the player at a folder of music. We'll read tags, fetch cover art,
            and let you optionally loop tracks forever via the Infinite Jukebox engine.
          </p>
        </div>

        <button
          type="button"
          onClick={onPickFolder}
          disabled={scanning}
          className={cn(
            "inline-flex items-center gap-2 rounded-full px-5 py-2.5",
            "bg-white text-black font-semibold shadow-[0_2px_12px_rgba(0,0,0,0.35)]",
            "transition-all hover:brightness-95 active:scale-[0.98]",
            "disabled:opacity-50 disabled:cursor-default",
          )}
        >
          {scanning ? (
            <>
              <Loader2 size={15} className="animate-spin" />
              Scanning…
            </>
          ) : (
            <>
              <FolderOpen size={15} />
              Choose music folder
            </>
          )}
        </button>

        {scanning && progress && (
          <p className="text-xs text-muted-foreground">
            {progress.label}{" "}
            <span className="font-mono">
              ({progress.scanned}/{progress.total || "?"})
            </span>
          </p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
        <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground/60">
          MP3 · FLAC · WAV · OGG · M4A · AAC · OPUS
        </p>
      </div>
    </div>
  );
}

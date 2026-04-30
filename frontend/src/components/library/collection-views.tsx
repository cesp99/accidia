import { useEffect, useMemo, useState } from "react";
import { Play, Shuffle } from "lucide-react";
import { cn } from "@/lib/utils";
import { TrackList } from "./track-list";
import type { store } from "../../../wailsjs/go/models";
import type { Track } from "@/hooks/use-queue";
import type { Playlist } from "@/hooks/use-playlists";

type Track_ = store.Track;

interface FavoritesViewProps {
  allTracks: Track_[];
  favoritePaths: string[];
  currentPath?: string;
  onPlay: (track: Track_, tracks: Track_[]) => void;
  onShufflePlay: (tracks: Track_[]) => void;
  onPlayNext: (tracks: Track_[]) => void;
  onAddToQueue: (tracks: Track_[]) => void;
  isFavorite: (path: string) => boolean;
  onToggleFavorite: (path: string) => void;
  playlists: Playlist[];
  onAddToPlaylist: (playlistId: string, paths: string[]) => void;
  onCreatePlaylistWithTracks: (paths: string[]) => void;
}

/**
 * Shows favorited tracks in "favorited most recently first" order.
 * Tracks that no longer exist in the library (moved/deleted) are
 * filtered out silently so the view stays clean.
 */
export function FavoritesView({
  allTracks,
  favoritePaths,
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
}: FavoritesViewProps) {
  const favoriteTracks = useMemo(() => {
    const byPath = new Map<string, Track_>();
    for (const t of allTracks) byPath.set(t.path, t);
    const out: Track_[] = [];
    for (const p of favoritePaths) {
      const t = byPath.get(p);
      if (t) out.push(t);
    }
    return out;
  }, [allTracks, favoritePaths]);

  const hasTracks = favoriteTracks.length > 0;

  return (
    <TrackList
      heading="Favorites"
      tracks={favoriteTracks}
      currentPath={currentPath}
      onPlay={(t, _, __) => onPlay(t, favoriteTracks)}
      onPlayNext={onPlayNext}
      onAddToQueue={onAddToQueue}
      isFavorite={isFavorite}
      onToggleFavorite={onToggleFavorite}
      playlists={playlists}
      onAddToPlaylist={onAddToPlaylist}
      onCreatePlaylistWithTracks={onCreatePlaylistWithTracks}
      flat
      sourceLabel="Favorites"
      emptyLabel="Nothing here yet"
      emptySubtitle="Tap the heart icon on any track to add it to Favorites."
      headerActions={
        hasTracks ? (
          <FavoritesActions
            onPlay={() => onPlay(favoriteTracks[0], favoriteTracks)}
            onShuffle={() => onShufflePlay(favoriteTracks)}
          />
        ) : null
      }
    />
  );
}

function FavoritesActions({
  onPlay,
  onShuffle,
}: {
  onPlay: () => void;
  onShuffle: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onPlay}
        className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-xs font-semibold text-black hover:brightness-95 active:scale-95"
      >
        <Play size={11} fill="currentColor" />
        Play
      </button>
      <button
        type="button"
        onClick={onShuffle}
        className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-muted-foreground hover:bg-white/10 hover:text-foreground"
      >
        <Shuffle size={11} />
        Shuffle
      </button>
    </div>
  );
}

interface PlaylistViewProps {
  allTracks: Track_[];
  playlist: Playlist;
  currentPath?: string;
  onPlay: (track: Track_, tracks: Track_[], label: string) => void;
  onShufflePlay: (tracks: Track_[], label: string) => void;
  onPlayNext: (tracks: Track_[]) => void;
  onAddToQueue: (tracks: Track_[]) => void;
  isFavorite: (path: string) => boolean;
  onToggleFavorite: (path: string) => void;
  playlists: Playlist[];
  onAddToPlaylist: (playlistId: string, paths: string[]) => void;
  onCreatePlaylistWithTracks: (paths: string[]) => void;
  onRemoveFromPlaylist: (paths: string[]) => void;
}

/**
 * Renders a single playlist's tracks in user-chosen order.
 */
export function PlaylistView({
  allTracks,
  playlist,
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
  onRemoveFromPlaylist,
}: PlaylistViewProps) {
  const tracks = useMemo(() => {
    const byPath = new Map<string, Track_>();
    for (const t of allTracks) byPath.set(t.path, t);
    const out: Track_[] = [];
    for (const p of playlist.paths || []) {
      const t = byPath.get(p);
      if (t) out.push(t);
    }
    return out;
  }, [allTracks, playlist.paths]);

  const label = `Playlist: ${playlist.name}`;
  const hasTracks = tracks.length > 0;

  return (
    <TrackList
      heading={playlist.name}
      tracks={tracks}
      currentPath={currentPath}
      onPlay={(t) => onPlay(t, tracks, label)}
      onPlayNext={onPlayNext}
      onAddToQueue={onAddToQueue}
      isFavorite={isFavorite}
      onToggleFavorite={onToggleFavorite}
      playlists={playlists}
      onAddToPlaylist={onAddToPlaylist}
      onCreatePlaylistWithTracks={onCreatePlaylistWithTracks}
      onRemoveFromPlaylist={onRemoveFromPlaylist}
      removeFromPlaylistLabel={`Remove from ${playlist.name}`}
      flat
      sourceLabel={label}
      emptyLabel="This playlist is empty"
      emptySubtitle="Right-click any track in your library and choose 'Add to playlist'."
      headerActions={
        hasTracks ? (
          <FavoritesActions
            onPlay={() => onPlay(tracks[0], tracks, label)}
            onShuffle={() => onShufflePlay(tracks, label)}
          />
        ) : null
      }
    />
  );
}

interface PlaylistPromptProps {
  open: boolean;
  title: string;
  initialName?: string;
  initialDescription?: string;
  onClose: () => void;
  onSubmit: (name: string, description: string) => Promise<void> | void;
  confirmLabel?: string;
}

/**
 * Inline rename/create modal. Intentionally tiny — we only need name +
 * description so a full dialog framework would be overkill.
 */
export function PlaylistPrompt({
  open,
  title,
  initialName = "",
  initialDescription = "",
  onClose,
  onSubmit,
  confirmLabel = "Save",
}: PlaylistPromptProps) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setDescription(initialDescription);
      setError(null);
    }
  }, [open, initialName, initialDescription]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Please give the playlist a name.");
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(trimmed, description.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "w-full max-w-md rounded-2xl border border-white/10 bg-[oklch(0.12_0.004_240)] p-5 shadow-[0_32px_120px_rgba(0,0,0,0.6)]",
        )}
      >
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Name
            </span>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60"
              placeholder="My Mix"
              maxLength={80}
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Description (optional)
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="mt-1 w-full resize-none rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60"
              placeholder="What's this about?"
              maxLength={200}
            />
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-muted-foreground hover:bg-white/10 hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-black hover:brightness-95 disabled:opacity-60"
          >
            {submitting ? "Saving…" : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

export type { Track };

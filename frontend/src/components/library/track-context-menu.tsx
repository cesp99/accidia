import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@/components/ui/context-menu";
import { Heart, ListMusic, Play, Plus, Trash2 } from "lucide-react";
import type { Track } from "@/hooks/use-queue";
import type { Playlist } from "@/hooks/use-playlists";

interface TrackContextMenuProps {
  children: React.ReactNode;
  track: Track;
  isFavorite: boolean;
  playlists: Playlist[];
  onPlay: () => void;
  onPlayNext: () => void;
  onAddToQueue: () => void;
  onToggleFavorite: () => void;
  onAddToPlaylist: (playlistId: string) => void;
  onCreatePlaylistWithTrack?: () => void;
  /** Only provided in the playlist-detail view. */
  onRemoveFromPlaylist?: () => void;
  removeFromPlaylistLabel?: string;
}

export function TrackContextMenu({
  children,
  track: _track,
  isFavorite,
  playlists,
  onPlay,
  onPlayNext,
  onAddToQueue,
  onToggleFavorite,
  onAddToPlaylist,
  onCreatePlaylistWithTrack,
  onRemoveFromPlaylist,
  removeFromPlaylistLabel,
}: TrackContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onPlay}>
          <Play size={13} fill="currentColor" />
          Play
        </ContextMenuItem>
        <ContextMenuItem onSelect={onPlayNext}>
          <ListMusic size={13} />
          Play next
        </ContextMenuItem>
        <ContextMenuItem onSelect={onAddToQueue}>
          <Plus size={13} />
          Add to queue
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem onSelect={onToggleFavorite}>
          <Heart size={13} fill={isFavorite ? "currentColor" : "none"} />
          {isFavorite ? "Remove from favorites" : "Add to favorites"}
        </ContextMenuItem>

        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <ListMusic size={13} />
            Add to playlist
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {onCreatePlaylistWithTrack && (
              <>
                <ContextMenuItem onSelect={onCreatePlaylistWithTrack}>
                  <Plus size={13} />
                  New playlist…
                </ContextMenuItem>
                {playlists.length > 0 && <ContextMenuSeparator />}
              </>
            )}
            {playlists.length === 0 ? (
              <ContextMenuItem disabled>No playlists yet</ContextMenuItem>
            ) : (
              playlists.map((pl) => (
                <ContextMenuItem key={pl.id} onSelect={() => onAddToPlaylist(pl.id)}>
                  {pl.name}
                </ContextMenuItem>
              ))
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>

        {onRemoveFromPlaylist && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={onRemoveFromPlaylist}>
              <Trash2 size={13} />
              {removeFromPlaylistLabel || "Remove from playlist"}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

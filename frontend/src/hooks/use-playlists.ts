import { useCallback, useEffect, useState } from "react";
import {
  AddToPlaylist,
  CreatePlaylist,
  DeletePlaylist,
  GetPlaylists,
  RemoveFromPlaylist,
  RenamePlaylist,
  ReorderPlaylist,
} from "../../wailsjs/go/main/App";
import type { collection } from "../../wailsjs/go/models";

export type Playlist = collection.Playlist;

/**
 * Reactive wrapper around the Go-backed playlists store.
 *
 * All mutations go through Go first — we re-read the authoritative list
 * after each call to avoid subtle merge bugs when multiple windows (or
 * the Go side itself) touch the file.
 */
export function usePlaylists() {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await GetPlaylists();
      setPlaylists(list);
      return list;
    } catch {
      return [] as Playlist[];
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = useCallback(
    async (name: string, description = ""): Promise<Playlist> => {
      const pl = await CreatePlaylist(name, description);
      await refresh();
      return pl;
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      await DeletePlaylist(id);
      await refresh();
    },
    [refresh],
  );

  const rename = useCallback(
    async (id: string, name: string, description = ""): Promise<Playlist> => {
      const pl = await RenamePlaylist(id, name, description);
      await refresh();
      return pl;
    },
    [refresh],
  );

  const add = useCallback(
    async (id: string, paths: string[]): Promise<Playlist> => {
      const pl = await AddToPlaylist(id, paths);
      await refresh();
      return pl;
    },
    [refresh],
  );

  const removeTracks = useCallback(
    async (id: string, paths: string[]): Promise<Playlist> => {
      const pl = await RemoveFromPlaylist(id, paths);
      await refresh();
      return pl;
    },
    [refresh],
  );

  const reorder = useCallback(
    async (id: string, paths: string[]): Promise<Playlist> => {
      const pl = await ReorderPlaylist(id, paths);
      await refresh();
      return pl;
    },
    [refresh],
  );

  return {
    playlists,
    loaded,
    refresh,
    create,
    remove,
    rename,
    add,
    removeTracks,
    reorder,
  };
}

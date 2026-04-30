import { useCallback, useEffect, useRef, useState } from "react";
import {
  GetFavorites,
  SetFavorite,
  ToggleFavorite,
} from "../../wailsjs/go/main/App";

/**
 * Thin reactive wrapper around the Go-backed favorites store.
 *
 * The Go side is the single source of truth. We keep a local set mirror
 * so lookup is O(1) from any component without round-tripping to Go on
 * every render. Every mutation goes through Go first — we only update
 * the local set after Go succeeds.
 */
export function useFavorites() {
  const [paths, setPaths] = useState<string[]>([]);
  const setRef = useRef<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    GetFavorites()
      .then((list) => {
        if (cancelled) return;
        setPaths(list);
        setRef.current = new Set(list);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isFavorite = useCallback((path: string): boolean => {
    if (!path) return false;
    return setRef.current.has(path);
  }, []);

  const setFavorite = useCallback(async (path: string, favorite: boolean): Promise<boolean> => {
    if (!path) return false;
    const next = await SetFavorite(path, favorite);
    // Optimistic: Go already persisted. Mirror it locally.
    if (next) {
      if (!setRef.current.has(path)) {
        setRef.current = new Set(setRef.current);
        setRef.current.add(path);
        setPaths((prev) => [path, ...prev.filter((p) => p !== path)]);
      }
    } else {
      if (setRef.current.has(path)) {
        setRef.current = new Set(setRef.current);
        setRef.current.delete(path);
        setPaths((prev) => prev.filter((p) => p !== path));
      }
    }
    return next;
  }, []);

  const toggleFavorite = useCallback(async (path: string): Promise<boolean> => {
    if (!path) return false;
    const next = await ToggleFavorite(path);
    if (next) {
      setRef.current = new Set(setRef.current);
      setRef.current.add(path);
      setPaths((prev) => [path, ...prev.filter((p) => p !== path)]);
    } else {
      setRef.current = new Set(setRef.current);
      setRef.current.delete(path);
      setPaths((prev) => prev.filter((p) => p !== path));
    }
    return next;
  }, []);

  return {
    paths,
    loaded,
    isFavorite,
    setFavorite,
    toggleFavorite,
  };
}

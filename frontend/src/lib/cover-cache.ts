// Shared cover-art cache.
//
// Cover art is fetched per source-track-path via the Go-bound GetCoverArt
// IPC. Without a shared cache every component that displays album/artist
// art (AlbumsGrid, ArtistsList, TrackList's AlbumGroupCard, the player
// bar, the now-playing view…) ends up re-issuing the same IPC call on
// every mount — which on big libraries can dominate tab-switch latency
// because each call opens the file and parses tags from disk.
//
// The cache is keyed by the *resolution source* — typically a track path
// chosen by groupByAlbum/groupByArtist — and stores the resolved result
// (data URL or null when no art was found). Repeat lookups are
// synchronous from then on.
//
// Lifetime: the cache lives for the duration of the page. Callers should
// invoke `clearCoverCache()` whenever the underlying library changes
// (rescan / folder swap) so we don't pin freed paths.
//
// In-flight de-duplication: simultaneous lookups for the same source
// share a single Promise so a 100-card mount only fires one IPC per
// album.

import { useEffect, useRef, useState } from "react";
import { GetCoverArt } from "../../wailsjs/go/main/App";

const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();
const subscribers = new Set<(source: string) => void>();

/** Returns the cached cover URL for `source` if known, otherwise undefined. */
export function getCachedCover(source: string): string | null | undefined {
  return cache.get(source);
}

/**
 * Synchronously hand back a cached value when present, otherwise dispatch
 * a single shared GetCoverArt call and resolve to it. Multiple callers in
 * the same tick collapse to one IPC.
 */
export function loadCover(source: string): Promise<string | null> {
  if (!source) return Promise.resolve(null);
  const existing = cache.get(source);
  if (existing !== undefined) return Promise.resolve(existing);
  const flight = inflight.get(source);
  if (flight) return flight;
  const p = GetCoverArt(source)
    .then((url) => {
      const resolved = url || null;
      cache.set(source, resolved);
      inflight.delete(source);
      // Wake every useCoverArt subscriber that's waiting on this source.
      for (const fn of subscribers) fn(source);
      return resolved;
    })
    .catch(() => {
      // Treat fetch failures as "no art" so we don't keep retrying on
      // every mount. A user-driven rescan clears the cache anyway.
      cache.set(source, null);
      inflight.delete(source);
      for (const fn of subscribers) fn(source);
      return null;
    });
  inflight.set(source, p);
  return p;
}

/**
 * Pre-warm the cache for the given list of artwork sources. Returns a
 * Promise that resolves once every source has either landed in the cache
 * or failed. Concurrency is bounded so we don't hammer the IPC bridge
 * with a thousand parallel file opens on first library load.
 */
export async function prewarmCovers(sources: Array<string | undefined>, concurrency = 8): Promise<void> {
  const unique = Array.from(
    new Set(sources.filter((s): s is string => typeof s === "string" && s.length > 0)),
  );
  // Skip anything we've already resolved (or that's currently in flight).
  const pending = unique.filter((s) => !cache.has(s) && !inflight.has(s));
  if (pending.length === 0) return;
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const limit = Math.max(1, Math.min(concurrency, pending.length));
  for (let i = 0; i < limit; i++) {
    workers.push(
      (async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= pending.length) return;
          await loadCover(pending[idx]);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

/**
 * Drop every entry from the cache. Call this on rescan / folder-change
 * to guarantee fresh art if the user replaced files on disk.
 */
export function clearCoverCache(): void {
  cache.clear();
  inflight.clear();
  // Notify subscribers with a sentinel so they can re-derive state.
  for (const fn of subscribers) fn("");
}

/**
 * Drop every cached entry whose source path isn't in `keep`. Used after
 * a rescan to evict art for tracks that no longer exist.
 */
export function pruneCoverCache(keep: Iterable<string>): void {
  const set = keep instanceof Set ? keep : new Set(keep);
  for (const k of Array.from(cache.keys())) {
    if (!set.has(k)) cache.delete(k);
  }
  for (const k of Array.from(inflight.keys())) {
    if (!set.has(k)) inflight.delete(k);
  }
  for (const fn of subscribers) fn("");
}

/**
 * React hook that resolves cover art for a single source. Returns the
 * cached value synchronously when known so the first paint already has
 * art if the cache was pre-warmed.
 */
export function useCoverArt(source?: string): string | null {
  const [art, setArt] = useState<string | null>(() =>
    source ? getCachedCover(source) ?? null : null,
  );
  // Keep a ref to the current source so the subscriber callback below
  // sees fresh values without re-subscribing on every render.
  const sourceRef = useRef(source);
  sourceRef.current = source;

  useEffect(() => {
    if (!source) {
      setArt(null);
      return;
    }
    const cached = getCachedCover(source);
    if (cached !== undefined) {
      setArt(cached);
      return;
    }
    let cancelled = false;
    loadCover(source).then((url) => {
      if (!cancelled) setArt(url);
    });
    // Subscribe so other paths populating the cache (e.g. prewarm) wake
    // us up too — covers the case where a sibling component fired the
    // IPC and we just want to read the result when it lands.
    const onChange = (changed: string) => {
      if (cancelled) return;
      if (changed === "" || changed === sourceRef.current) {
        const next = sourceRef.current ? getCachedCover(sourceRef.current) : undefined;
        if (next !== undefined) setArt(next ?? null);
      }
    };
    subscribers.add(onChange);
    return () => {
      cancelled = true;
      subscribers.delete(onChange);
    };
  }, [source]);

  return art;
}

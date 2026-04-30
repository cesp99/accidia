import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface BlurBackgroundProps {
  /** Optional album-art data URL. When present, it's the dominant visual. */
  coverUrl?: string | null;
  /** Whether playback is active — drives the slow-pan animation. */
  isPlaying?: boolean;
  /**
   * Opacity of the dark base layer (0–1). 1.0 = fully opaque — the host
   * OS desktop is completely hidden. Values <1 let the compositor's
   * blur / vibrancy show the wallpaper through. User-controlled from
   * the Settings tab.
   *
   * Pass `null` (or omit) while the persisted value is still loading
   * — the component will render no base layer at all in that state,
   * which keeps the first paint flicker-free. The window is held
   * hidden by Wails until the value lands; this prop type lets us
   * model that explicitly.
   */
  backdropOpacity?: number | null;
}

/** Cap the cover-art layer at this opacity to keep the UI readable. */
const COVER_MAX_OPACITY = 0.1;

/**
 * Minimalist full-window backdrop.
 *
 * Two stacked layers inside a pointer-events-none container:
 *
 *  1. A flat `bg-background` base layer whose opacity the user can
 *     tune in Settings. At 1.0 the host OS desktop is fully hidden; at
 *     lower values the compositor's vibrancy/wallpaper shows through.
 *  2. The current album art, blurred to oblivion, capped at 10% opacity
 *     and composited on top of the base. Cross-fades between tracks.
 *
 * html/body/#root are intentionally `background: transparent` in
 * globals.css so platforms with native translucency (macOS vibrancy,
 * Windows Mica, Linux compositor blur) can do their thing — this
 * component is the single source of truth for the in-app backdrop.
 *
 * The blurred cover layer keeps `animate-slow-pan` active even when
 * paused (with `animation-play-state: paused`) instead of toggling
 * the class on/off. Removing the class fell off the GPU compositor,
 * which made WebKit re-rasterise the 100px blur with a different
 * algorithm and the whole window subtly darkened on every pause —
 * the "UI gets strangely darker when paused" symptom users hit.
 * Keeping the class always-on pins the layer on the compositor and
 * keeps the rendered colour stable across play/pause.
 */
export function BlurBackground({ coverUrl, isPlaying, backdropOpacity }: BlurBackgroundProps) {
  const [layers, setLayers] = useState<{ url: string; key: number }[]>([]);
  const counter = useRef(0);

  // Cross-fade between covers instead of snapping.
  useEffect(() => {
    if (!coverUrl) {
      setLayers([]);
      return;
    }
    counter.current += 1;
    const key = counter.current;
    setLayers((prev) => [...prev.slice(-1), { url: coverUrl, key }]);
    const t = window.setTimeout(() => {
      setLayers((prev) => prev.filter((l) => l.key === key));
    }, 1200);
    return () => clearTimeout(t);
  }, [coverUrl]);

  // Until the persisted opacity is known we render *nothing* for the
  // base layer — that keeps the first paint at zero flicker risk
  // (the window is still hidden by Wails at this point anyway).
  const baseOpacity =
    backdropOpacity == null ? null : Math.max(0, Math.min(1, backdropOpacity));

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
    >
      {/* Opaque base — masks the desktop bleed-through. Opacity is
          user-tunable via Settings (backdropOpacity). */}
      {baseOpacity !== null && (
        <div
          className="absolute inset-0 bg-background transition-opacity duration-300"
          style={{ opacity: baseOpacity }}
        />
      )}

      {/* Blurred cover art — only rendered when a track is loaded.
          Animation stays active permanently to keep the layer pinned
          to the GPU compositor (see file-level comment). */}
      {layers.map((layer) => (
        <div
          key={layer.key}
          className={cn(
            "absolute inset-0 transition-opacity duration-[1200ms]",
            "animate-slow-pan will-change-transform",
          )}
          style={{
            backgroundImage: `url(${layer.url})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            filter: "blur(100px) saturate(140%)",
            opacity: COVER_MAX_OPACITY,
            animationPlayState: isPlaying ? "running" : "paused",
          }}
        />
      ))}
    </div>
  );
}

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
   */
  backdropOpacity?: number;
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
 */
export function BlurBackground({ coverUrl, isPlaying, backdropOpacity = 1 }: BlurBackgroundProps) {
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

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
    >
      {/* Opaque base — masks the desktop bleed-through. Opacity is
          user-tunable via Settings (backdropOpacity). */}
      <div
        className="absolute inset-0 bg-background transition-opacity duration-300"
        style={{ opacity: Math.max(0, Math.min(1, backdropOpacity)) }}
      />

      {/* Blurred cover art — only rendered when a track is loaded. */}
      {layers.map((layer) => (
        <div
          key={layer.key}
          className={cn(
            "absolute inset-0 transition-opacity duration-[1200ms]",
            isPlaying && "animate-slow-pan",
          )}
          style={{
            backgroundImage: `url(${layer.url})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            filter: "blur(100px) saturate(140%)",
            transform: "scale(1.2)",
            opacity: COVER_MAX_OPACITY,
          }}
        />
      ))}
    </div>
  );
}

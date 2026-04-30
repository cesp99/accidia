import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface BlurBackgroundProps {
  /** Optional album-art data URL. When present, it's the dominant visual. */
  coverUrl?: string | null;
  /** Whether playback is active — drives the slow-pan animation. */
  isPlaying?: boolean;
}

/** Cap the cover-art layer at this opacity to keep the UI readable. */
const COVER_MAX_OPACITY = 0.3;

/**
 * Minimalist full-window backdrop.
 *
 * Design: no decorative gradients, no brand-coloured blobs. The viewport is
 * either the transparent host window (so the compositor's blur shines
 * through) or, when a track is playing, the current album artwork blurred
 * to oblivion and capped at 30% opacity so text always stays legible
 * against the underlying dark body.
 */
export function BlurBackground({ coverUrl, isPlaying }: BlurBackgroundProps) {
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
      {/* Blurred cover art — only rendered when a track is loaded. The
          layer itself is capped at 30% opacity; the dark app body shows
          through for the remaining 70%, which keeps text contrast high
          without needing an extra black tint overlay on top. */}
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
            filter: "blur(100px) saturate(160%)",
            transform: "scale(1.2)",
            opacity: COVER_MAX_OPACITY,
          }}
        />
      ))}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface BlurBackgroundProps {
  /** Optional album-art data URL. When present, it's the dominant visual. */
  coverUrl?: string | null;
  /** Whether playback is active — drives the slow-pan animation. */
  isPlaying?: boolean;
}

/**
 * Minimalist full-window backdrop.
 *
 * Design: no decorative gradients, no brand-coloured blobs. The viewport is
 * either the transparent host window (so the compositor's blur shines
 * through) or, when a track is playing, the current album artwork blurred
 * to oblivion and dimmed by a flat 25% black layer for text contrast.
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
            filter: "blur(100px) saturate(160%)",
            transform: "scale(1.2)",
          }}
        />
      ))}

      {/* Flat 25% black tint. Provides text contrast over the cover art and
          a neutral fog over the desktop when no track is loaded. */}
      <div className="absolute inset-0 bg-black/25" />
    </div>
  );
}

"use client";

import { useEffect, useRef, useCallback } from "react";
import type { Beat, Edge } from "@/hooks/use-audio-engine";

interface BeatCircleProps {
  beats: Beat[];
  edges: Edge[];
  currentBeat: number;
  lastJump: { from: number; to: number } | null;
  duration: number;
  onBeatClick?: (beatIndex: number) => void;
}

// Default square design frame used for sizing conversions
const DESIGN_SIZE = 600;
// Base dot radii expressed in CSS pixels at DESIGN_SIZE; will be scaled
// with sqrt(size/DESIGN_SIZE) so mobile dots don't vanish.
const BEAT_DOT_R = 4;
const ACTIVE_DOT_R = 7;

function circleGeometry(size: number) {
  // Larger fill on small screens, more breathing room on desktop.
  const radiusRatio = size <= 420 ? 0.44 : 0.38;
  return {
    cx: size / 2,
    cy: size / 2,
    r: size * radiusRatio,
  };
}

// Map beat index to angle in radians (0 = top, clockwise)
function beatAngle(beatIndex: number, totalBeats: number): number {
  if (totalBeats <= 0) return -Math.PI / 2;
  return (beatIndex / totalBeats) * 2 * Math.PI - Math.PI / 2;
}

// Map beat index to x,y on the circle (CSS pixels)
function beatPos(beatIndex: number, totalBeats: number, radius: number, centerX: number, centerY: number) {
  const angle = beatAngle(beatIndex, totalBeats);
  return {
    x: centerX + radius * Math.cos(angle),
    y: centerY + radius * Math.sin(angle),
  };
}

export function BeatCircle({
  beats,
  edges,
  currentBeat,
  lastJump,
  duration: _duration,
  onBeatClick,
}: BeatCircleProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const jumpFlashRef = useRef<{ from: number; to: number; opacity: number } | null>(null);
  const animRef = useRef<number>(0);

  // Keep latest values in refs so the draw loop can read them without
  // resubscribing to RAF on every state change.
  const beatsRef = useRef<Beat[]>(beats);
  const edgesRef = useRef<Edge[]>(edges);
  const currentBeatRef = useRef<number>(currentBeat);
  const sizeRef = useRef<number>(DESIGN_SIZE);

  beatsRef.current = beats;
  edgesRef.current = edges;
  currentBeatRef.current = currentBeat;

  // Detect jumps
  useEffect(() => {
    if (lastJump && lastJump.from !== lastJump.to) {
      jumpFlashRef.current = { ...lastJump, opacity: 1.0 };
    }
  }, [lastJump]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const beats = beatsRef.current;
    const edges = edgesRef.current;
    const currentBeat = currentBeatRef.current;
    const n = beats.length;
    if (!n) return;

    const dpr = window.devicePixelRatio || 1;
    const size = sizeRef.current;
    // Scale context so we can draw everything in CSS pixel units regardless
    // of device pixel ratio. This was the source of the "circle in the
    // top-left quadrant" bug on mobile / retina screens.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    // Dot radius scales gently with the overall size so they stay visible
    // on phones and never get absurdly large on desktop.
    const dotScale = Math.max(0.7, Math.min(1.4, Math.sqrt(size / DESIGN_SIZE)));
    const { cx, cy, r } = circleGeometry(size);

    // Background ring
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Draw all edges (faint)
    for (const edge of edges) {
      const from = beatPos(edge.from, n, r, cx, cy);
      const to = beatPos(edge.to, n, r, cx, cy);
      const cpX = cx + (cx - (from.x + to.x) / 2) * 0.3;
      const cpY = cy + (cy - (from.y + to.y) / 2) * 0.3;

      const alpha = 0.04 + (edge.similarity - 0.85) * 0.2;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.quadraticCurveTo(cpX, cpY, to.x, to.y);
      ctx.strokeStyle = `rgba(0, 180, 220, ${alpha.toFixed(3)})`;
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }

    // Highlight edges from/to current beat
    for (const edge of edges) {
      if (edge.from !== currentBeat && edge.to !== currentBeat) continue;
      const from = beatPos(edge.from, n, r, cx, cy);
      const to = beatPos(edge.to, n, r, cx, cy);
      const cpX = cx + (cx - (from.x + to.x) / 2) * 0.3;
      const cpY = cy + (cy - (from.y + to.y) / 2) * 0.3;

      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.quadraticCurveTo(cpX, cpY, to.x, to.y);
      ctx.strokeStyle = "rgba(0, 229, 255, 0.35)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // Draw jump flash
    const flash = jumpFlashRef.current;
    if (flash && flash.opacity > 0) {
      const from = beatPos(flash.from, n, r, cx, cy);
      const to = beatPos(flash.to, n, r, cx, cy);
      const cpX = cx + (cx - (from.x + to.x) / 2) * 0.3;
      const cpY = cy + (cy - (from.y + to.y) / 2) * 0.3;

      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.quadraticCurveTo(cpX, cpY, to.x, to.y);
      ctx.strokeStyle = `rgba(251, 191, 36, ${flash.opacity.toFixed(2)})`;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = "rgba(251, 191, 36, 0.8)";
      ctx.shadowBlur = 12;
      ctx.stroke();
      ctx.shadowBlur = 0;

      flash.opacity -= 0.03;
      if (flash.opacity <= 0) jumpFlashRef.current = null;
    }

    // Draw beat dots
    for (let i = 0; i < n; i++) {
      const pos = beatPos(i, n, r, cx, cy);
      const isActive = i === currentBeat;
      const isAdjacentToActive = Math.abs(i - currentBeat) <= 2;

      ctx.beginPath();
      ctx.arc(
        pos.x,
        pos.y,
        (isActive ? ACTIVE_DOT_R : BEAT_DOT_R) * dotScale,
        0,
        2 * Math.PI,
      );

      if (isActive) {
        ctx.fillStyle = "#00e5ff";
        ctx.shadowColor = "#00e5ff";
        ctx.shadowBlur = 16;
      } else if (isAdjacentToActive) {
        ctx.fillStyle = "rgba(0, 229, 255, 0.5)";
        ctx.shadowBlur = 0;
      } else {
        ctx.fillStyle = "rgba(100, 120, 160, 0.5)";
        ctx.shadowBlur = 0;
      }
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Playhead sweep line from center to active beat
    const activePos = beatPos(currentBeat, n, r, cx, cy);
    const gradient = ctx.createLinearGradient(cx, cy, activePos.x, activePos.y);
    gradient.addColorStop(0, "rgba(0, 229, 255, 0)");
    gradient.addColorStop(1, "rgba(0, 229, 255, 0.6)");
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(activePos.x, activePos.y);
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    animRef.current = requestAnimationFrame(draw);
  }, []);

  useEffect(() => {
    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [draw]);

  // Keep canvas bitmap and CSS size in sync with its square container.
  // We set the canvas bitmap to (size * dpr) so drawing stays crisp on
  // high-DPI displays, while CSS size stays at `size` so the element
  // occupies the expected square on the page.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const parentWidth = parent?.clientWidth ?? DESIGN_SIZE;
      // Respect layout constraints up to the design size, but never collapse
      // below a usable viewport for touch targets.
      const size = Math.max(200, Math.min(parentWidth, DESIGN_SIZE));
      const bitmap = Math.round(size * dpr);
      if (canvas.width !== bitmap) canvas.width = bitmap;
      if (canvas.height !== bitmap) canvas.height = bitmap;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
      sizeRef.current = size;
    };

    resize();
    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(resize)
      : null;
    if (observer && parent) observer.observe(parent);
    window.addEventListener("resize", resize);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, []);

  const handlePointer = useCallback(
    (clientX: number, clientY: number) => {
      if (!onBeatClick) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const n = beatsRef.current.length;
      if (!n) return;

      const rect = canvas.getBoundingClientRect();
      // clientX/Y minus rect gives us CSS-pixel coordinates inside the
      // element, which matches how drawing is done after setTransform(dpr).
      const mx = clientX - rect.left;
      const my = clientY - rect.top;
      const size = rect.width || sizeRef.current;
      const { cx, cy, r } = circleGeometry(size);

      let closest = -1;
      let minDist = Infinity;
      for (let i = 0; i < n; i++) {
        const pos = beatPos(i, n, r, cx, cy);
        const dist = Math.hypot(mx - pos.x, my - pos.y);
        if (dist < minDist) {
          minDist = dist;
          closest = i;
        }
      }
      // Generous hit radius on mobile so taps near a dot still land.
      const hitRadius = Math.max(18, size * 0.04);
      if (closest >= 0 && minDist < hitRadius) {
        onBeatClick(closest);
      }
    },
    [onBeatClick],
  );

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      handlePointer(e.clientX, e.clientY);
    },
    [handlePointer],
  );

  const handleCanvasTouch = useCallback(
    (e: React.TouchEvent<HTMLCanvasElement>) => {
      const touch = e.changedTouches[0];
      if (!touch) return;
      // Prevent synthetic mouse events from firing a second time.
      e.preventDefault();
      handlePointer(touch.clientX, touch.clientY);
    },
    [handlePointer],
  );

  return (
    <div className="relative flex w-full items-center justify-center overflow-visible">
      <canvas
        ref={canvasRef}
        onClick={handleCanvasClick}
        onTouchEnd={handleCanvasTouch}
        className="block cursor-pointer touch-manipulation select-none"
      />
    </div>
  );
}

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

const RADIUS = 220;
const CENTER = 300;
const SVG_SIZE = 600;
const BEAT_DOT_R = 4;
const ACTIVE_DOT_R = 7;

function circleGeometry(size: number) {
  // Larger fill on small screens, more breathing room on desktop.
  const radiusRatio = size <= 420 ? 0.44 : 0.37;
  return {
    cx: size / 2,
    cy: size / 2,
    r: size * radiusRatio,
  };
}

// Map beat index to angle in radians (0 = top, clockwise)
function beatAngle(beatIndex: number, totalBeats: number): number {
  return (beatIndex / totalBeats) * 2 * Math.PI - Math.PI / 2;
}

// Map beat index to x,y on the circle
function beatPos(beatIndex: number, totalBeats: number, radius = RADIUS, center = CENTER) {
  const angle = beatAngle(beatIndex, totalBeats);
  return {
    x: center + radius * Math.cos(angle),
    y: center + radius * Math.sin(angle),
  };
}

// Cubic bezier arc through center for a "chord" style arc
function arcPath(fromIdx: number, toIdx: number, totalBeats: number): string {
  const from = beatPos(fromIdx, totalBeats);
  const to = beatPos(toIdx, totalBeats);
  // Control point: slightly pulled toward center
  const cpX = CENTER + (CENTER - (from.x + to.x) / 2) * 0.3;
  const cpY = CENTER + (CENTER - (from.y + to.y) / 2) * 0.3;
  return `M ${from.x} ${from.y} Q ${cpX} ${cpY} ${to.x} ${to.y}`;
}

export function BeatCircle({
  beats,
  edges,
  currentBeat,
  lastJump,
  duration,
  onBeatClick,
}: BeatCircleProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const jumpFlashRef = useRef<{ from: number; to: number; opacity: number } | null>(null);
  const animRef = useRef<number>(0);
  const prevBeatRef = useRef(currentBeat);

  const n = beats.length;

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
    if (!ctx || !n) return;

    const dpr = window.devicePixelRatio || 1;
    const size = canvas.width / dpr;
    const scale = size / SVG_SIZE;
    const { cx, cy, r } = circleGeometry(size);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background ring
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Draw all edges (faint)
    for (const edge of edges) {
      const from = beatPos(edge.from, n, r, cx);
      const to = beatPos(edge.to, n, r, cx);
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
    const activeEdges = edges.filter(
      (e) => e.from === currentBeat || e.to === currentBeat
    );
    for (const edge of activeEdges) {
      const from = beatPos(edge.from, n, r, cx);
      const to = beatPos(edge.to, n, r, cx);
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
      const from = beatPos(flash.from, n, r, cx);
      const to = beatPos(flash.to, n, r, cx);
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
      const pos = beatPos(i, n, r, cx);
      const isActive = i === currentBeat;
      const isAdjacentToActive = Math.abs(i - currentBeat) <= 2;

      ctx.beginPath();
      ctx.arc(pos.x, pos.y, isActive ? ACTIVE_DOT_R * scale : BEAT_DOT_R * scale, 0, 2 * Math.PI);

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
    if (n > 0) {
      const activePos = beatPos(currentBeat, n, r, cx);
      const gradient = ctx.createLinearGradient(cx, cy, activePos.x, activePos.y);
      gradient.addColorStop(0, "rgba(0, 229, 255, 0)");
      gradient.addColorStop(1, "rgba(0, 229, 255, 0.6)");
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(activePos.x, activePos.y);
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    prevBeatRef.current = currentBeat;
    animRef.current = requestAnimationFrame(draw);
  }, [beats, edges, currentBeat, n]); // eslint-disable-line

  useEffect(() => {
    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [draw]);

  // Keep canvas bitmap and CSS size in sync with its square container.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const size = Math.min(canvas.parentElement?.clientWidth ?? SVG_SIZE, SVG_SIZE);
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
    };

    resize();
    const observer = new ResizeObserver(resize);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    window.addEventListener("resize", resize);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, []);

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!onBeatClick || !n) return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const scaleX = canvas.width / (rect.width * dpr);
      const scaleY = canvas.height / (rect.height * dpr);
      const mx = ((e.clientX - rect.left) * dpr * scaleX) / dpr;
      const my = ((e.clientY - rect.top) * dpr * scaleY) / dpr;
      const size = canvas.width / dpr;
      const scale = size / SVG_SIZE;
      const { cx, cy, r } = circleGeometry(size);

      // Find closest beat
      let closest = -1;
      let minDist = Infinity;
      for (let i = 0; i < n; i++) {
        const pos = beatPos(i, n, r, cx);
        const dist = Math.hypot(mx - pos.x, my - pos.y);
        if (dist < minDist) {
          minDist = dist;
          closest = i;
        }
      }
      if (closest >= 0 && minDist < 20 * scale) {
        onBeatClick(closest);
      }
    },
    [n, onBeatClick]
  );

  return (
    <div className="relative flex w-full items-center justify-center overflow-visible">
      <canvas
        ref={canvasRef}
        onClick={handleCanvasClick}
        className="block cursor-pointer"
      />
    </div>
  );
}

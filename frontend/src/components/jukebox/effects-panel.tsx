import { useMemo } from "react";
import {
  SlidersHorizontal,
  AudioLines,
  Activity,
  Waves,
  Filter as FilterIcon,
  Flame,
  Repeat,
  CassetteTape,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Slider } from "@/components/ui/slider";
import { effectsPresets, type EffectsState, type CompressorMode, type PresetName } from "@/lib/audio-effects";

interface EffectsPanelProps {
  state: EffectsState;
  onChange: (next: EffectsState) => void;
}

interface EffectCardProps {
  title: string;
  description: string;
  enabled: boolean;
  accent: "cyan" | "amber" | "violet" | "emerald" | "rose" | "sky" | "orange";
  icon: React.ReactNode;
  onToggle: (next: boolean) => void;
  children?: React.ReactNode;
}

const ACCENT_CLASSES: Record<EffectCardProps["accent"], string> = {
  cyan: "bg-primary/15 text-primary border-primary/40 shadow-primary/30",
  amber: "bg-accent/15 text-accent border-accent/40 shadow-accent/30",
  violet:
    "bg-[color:oklch(0.65_0.2_290)]/15 text-[color:oklch(0.72_0.2_290)] border-[color:oklch(0.72_0.2_290)]/40",
  emerald:
    "bg-[color:oklch(0.72_0.18_160)]/15 text-[color:oklch(0.78_0.18_160)] border-[color:oklch(0.78_0.18_160)]/40",
  rose:
    "bg-[color:oklch(0.72_0.2_15)]/15 text-[color:oklch(0.78_0.18_15)] border-[color:oklch(0.78_0.18_15)]/40",
  sky:
    "bg-[color:oklch(0.75_0.15_220)]/15 text-[color:oklch(0.82_0.16_220)] border-[color:oklch(0.82_0.16_220)]/40",
  orange:
    "bg-[color:oklch(0.75_0.17_55)]/15 text-[color:oklch(0.82_0.17_55)] border-[color:oklch(0.82_0.17_55)]/40",
};

function EffectCard({ title, description, enabled, accent, icon, onToggle, children }: EffectCardProps) {
  return (
    <div
      className={cn(
        "rounded-xl border p-4 transition-all",
        enabled
          ? "border-border/80 bg-card/80 shadow-inner"
          : "border-border/30 bg-card/40",
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(!enabled)}
        className="w-full flex items-center justify-between gap-3 text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={cn(
              "w-9 h-9 rounded-lg flex items-center justify-center border shrink-0 transition-all",
              enabled
                ? ACCENT_CLASSES[accent]
                : "bg-secondary/60 text-muted-foreground border-border/30",
            )}
          >
            {icon}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground truncate">{title}</p>
            <p className="text-xs text-muted-foreground truncate">{description}</p>
          </div>
        </div>
        <span
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors",
            enabled ? "bg-primary" : "bg-secondary",
          )}
          aria-hidden
        >
          <span
            className={cn(
              "absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
              enabled ? "translate-x-4" : "translate-x-0",
            )}
          />
        </span>
      </button>
      {enabled && children ? <div className="mt-4 space-y-3">{children}</div> : null}
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  accent = "primary",
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  accent?: "primary" | "accent";
}) {
  const displayValue = format ? format(value) : value.toFixed(2);
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="text-xs tabular-nums text-foreground/80 font-mono">{displayValue}</span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([v]) => onChange(v)}
        className={cn(
          accent === "accent"
            ? "[&_[data-slot=slider-range]]:bg-accent [&_[data-slot=slider-thumb]]:border-accent"
            : "[&_[data-slot=slider-range]]:bg-primary [&_[data-slot=slider-thumb]]:border-primary",
        )}
      />
    </div>
  );
}

function ModeSelector({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ label: string; value: string; description?: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 p-0.5 rounded-lg bg-secondary/60 border border-border/30">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            "flex-1 min-w-[72px] px-2.5 py-1.5 text-xs rounded-md transition-all text-center",
            value === opt.value
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
          title={opt.description}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function EffectsPanel({ state, onChange }: EffectsPanelProps) {
  const patch = useMemo(
    () =>
      <K extends keyof EffectsState>(key: K, partial: Partial<EffectsState[K]>) => {
        onChange({ ...state, [key]: { ...state[key], ...partial } });
      },
    [state, onChange],
  );

  const dbFormat = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
  const pctFormat = (v: number) => `${Math.round(v * 100)}%`;
  const msFormat = (v: number) => `${Math.round(v * 1000)} ms`;
  const sFormat = (v: number) => `${v.toFixed(2)} s`;
  const hzFormat = (v: number) => {
    if (v >= 1000) return `${(v / 1000).toFixed(1)} kHz`;
    return `${Math.round(v)} Hz`;
  };

  const activeCount =
    Number(state.eq.enabled) +
    Number(state.filter.enabled) +
    Number(state.distortion.enabled) +
    Number(state.compressor.enabled) +
    Number(state.reverb.enabled) +
    Number(state.delay.enabled) +
    Number(state.cassette.enabled);

  const presetOrder: PresetName[] = ["clean", "lofi", "club", "radio", "dreamy", "destroy"];

  return (
    <div className="w-full max-w-lg mx-auto space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SlidersHorizontal size={13} className="text-muted-foreground" />
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
            Effects
          </span>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {activeCount} active
        </span>
      </div>

      {/* Preset bar */}
      <div className="rounded-lg border border-border/40 bg-card/60 p-2 space-y-2">
        <div className="flex items-center gap-1.5 px-1">
          <Sparkles size={11} className="text-primary" />
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
            Presets
          </span>
        </div>
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
          {presetOrder.map((key) => {
            const preset = effectsPresets[key];
            return (
              <button
                key={key}
                type="button"
                onClick={() => onChange(preset.state)}
                className={cn(
                  "px-2 py-1.5 text-xs rounded-md transition-all",
                  "bg-secondary/60 text-muted-foreground border border-border/30",
                  "hover:text-foreground hover:border-border hover:bg-secondary",
                  "active:scale-95",
                )}
                title={preset.description}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3">
        {/* EQ */}
        <EffectCard
          title="3-Band EQ"
          description="Shape the low, mid, and high frequencies"
          enabled={state.eq.enabled}
          accent="cyan"
          icon={<AudioLines size={16} />}
          onToggle={(on) => patch("eq", { enabled: on })}
        >
          <SliderRow
            label="Bass"
            value={state.eq.bass}
            min={-12}
            max={12}
            step={0.5}
            format={dbFormat}
            onChange={(v) => patch("eq", { bass: v })}
          />
          <SliderRow
            label="Mid"
            value={state.eq.mid}
            min={-12}
            max={12}
            step={0.5}
            format={dbFormat}
            onChange={(v) => patch("eq", { mid: v })}
          />
          <SliderRow
            label="Treble"
            value={state.eq.treble}
            min={-12}
            max={12}
            step={0.5}
            format={dbFormat}
            onChange={(v) => patch("eq", { treble: v })}
          />
        </EffectCard>

        {/* Filter */}
        <EffectCard
          title="DJ Filter"
          description="Low-pass cutoff sweep with resonance"
          enabled={state.filter.enabled}
          accent="sky"
          icon={<FilterIcon size={16} />}
          onToggle={(on) => patch("filter", { enabled: on })}
        >
          <SliderRow
            label="Cutoff"
            value={state.filter.cutoff}
            min={0}
            max={1}
            step={0.01}
            format={(v) => {
              const minF = 80;
              const maxF = 20000;
              return hzFormat(minF * Math.pow(maxF / minF, v));
            }}
            onChange={(v) => patch("filter", { cutoff: v })}
          />
          <SliderRow
            label="Resonance"
            value={state.filter.resonance}
            min={0.1}
            max={12}
            step={0.1}
            format={(v) => v.toFixed(1)}
            onChange={(v) => patch("filter", { resonance: v })}
          />
        </EffectCard>

        {/* Distortion */}
        <EffectCard
          title="Drive"
          description="Waveshaper saturation with wet/dry mix"
          enabled={state.distortion.enabled}
          accent="rose"
          icon={<Flame size={16} />}
          onToggle={(on) => patch("distortion", { enabled: on })}
        >
          <SliderRow
            label="Amount"
            value={state.distortion.amount}
            min={0}
            max={1}
            step={0.01}
            format={pctFormat}
            onChange={(v) => patch("distortion", { amount: v })}
          />
          <SliderRow
            label="Mix"
            value={state.distortion.mix}
            min={0}
            max={1}
            step={0.01}
            format={pctFormat}
            onChange={(v) => patch("distortion", { mix: v })}
          />
        </EffectCard>

        {/* Compressor */}
        <EffectCard
          title="Compressor"
          description="Glue dynamics with Native / Warm / Bright modes"
          enabled={state.compressor.enabled}
          accent="amber"
          icon={<Activity size={16} />}
          onToggle={(on) => patch("compressor", { enabled: on })}
        >
          <ModeSelector
            value={state.compressor.mode}
            options={[
              { label: "Native", value: "native", description: "Clean 4:1 compression" },
              { label: "Warm Tape", value: "warmTape", description: "SP-303 style saturation" },
              { label: "Bright", value: "brightOpen", description: "SP-404 style air boost" },
            ]}
            onChange={(v) => patch("compressor", { mode: v as CompressorMode })}
          />
          <SliderRow
            label="Makeup"
            value={state.compressor.makeup}
            min={0}
            max={2}
            step={0.01}
            format={(v) => `${v.toFixed(2)}x`}
            accent="accent"
            onChange={(v) => patch("compressor", { makeup: v })}
          />
        </EffectCard>

        {/* Reverb */}
        <EffectCard
          title="Reverb"
          description="Convolution reverb with adjustable size"
          enabled={state.reverb.enabled}
          accent="violet"
          icon={<Waves size={16} />}
          onToggle={(on) => patch("reverb", { enabled: on })}
        >
          <SliderRow
            label="Mix"
            value={state.reverb.mix}
            min={0}
            max={1}
            step={0.01}
            format={pctFormat}
            onChange={(v) => patch("reverb", { mix: v })}
          />
          <SliderRow
            label="Size"
            value={state.reverb.size}
            min={0.3}
            max={4}
            step={0.1}
            format={sFormat}
            onChange={(v) => patch("reverb", { size: v })}
          />
        </EffectCard>

        {/* Delay */}
        <EffectCard
          title="Delay"
          description="Echo with feedback and high-end damping"
          enabled={state.delay.enabled}
          accent="emerald"
          icon={<Repeat size={16} />}
          onToggle={(on) => patch("delay", { enabled: on })}
        >
          <SliderRow
            label="Time"
            value={state.delay.time}
            min={0.05}
            max={1.5}
            step={0.01}
            format={msFormat}
            onChange={(v) => patch("delay", { time: v })}
          />
          <SliderRow
            label="Feedback"
            value={state.delay.feedback}
            min={0}
            max={0.9}
            step={0.01}
            format={pctFormat}
            onChange={(v) => patch("delay", { feedback: v })}
          />
          <SliderRow
            label="Mix"
            value={state.delay.mix}
            min={0}
            max={1}
            step={0.01}
            format={pctFormat}
            onChange={(v) => patch("delay", { mix: v })}
          />
        </EffectCard>

        {/* Cassette */}
        <EffectCard
          title="Cassette"
          description="Lo-fi bit reduction, sample-rate crush, tape noise"
          enabled={state.cassette.enabled}
          accent="orange"
          icon={<CassetteTape size={16} />}
          onToggle={(on) => patch("cassette", { enabled: on })}
        >
          <SliderRow
            label="Bit depth"
            value={state.cassette.bitDepth}
            min={6}
            max={16}
            step={1}
            format={(v) => `${Math.round(v)}-bit`}
            onChange={(v) => patch("cassette", { bitDepth: Math.round(v) })}
          />
          <SliderRow
            label="Tone"
            value={state.cassette.cutoff}
            min={1200}
            max={14000}
            step={100}
            format={hzFormat}
            onChange={(v) => patch("cassette", { cutoff: v })}
          />
          <SliderRow
            label="Tape noise"
            value={state.cassette.noise}
            min={0}
            max={0.003}
            step={0.0001}
            format={(v) => `${(v * 100000).toFixed(0)}`}
            onChange={(v) => patch("cassette", { noise: v })}
          />
        </EffectCard>
      </div>
    </div>
  );
}

// Audio effects chain for the Infinite Jukebox.
// Effects are inspired by the YouTube Beatmaker Cues extension (owae.ga)
// but reworked for a pure Web Audio pipeline suitable for a Next.js app.
//
// Signal flow:
//   source -> input gain -> EQ -> filter -> distortion -> compressor
//          -> reverb (wet/dry) -> delay (wet/dry) -> cassette -> output gain -> destination
//
// Each effect exposes its input/output nodes, a `setEnabled` toggle that
// does a smooth gain crossfade rather than reconnecting the graph, and
// small param setters bound to Web Audio params so updates are sample-
// accurate and click-free.

export type CompressorMode = "native" | "warmTape" | "brightOpen";

export interface EQState {
  enabled: boolean;
  /** -12 to +12 dB */
  bass: number;
  /** -12 to +12 dB */
  mid: number;
  /** -12 to +12 dB */
  treble: number;
}

export interface FilterState {
  enabled: boolean;
  /** 0..1 sweep: 0 = full lowpass close, 1 = fully open */
  cutoff: number;
  /** 0..10 resonance */
  resonance: number;
}

export interface CompressorState {
  enabled: boolean;
  mode: CompressorMode;
  /** 0..2 output makeup gain */
  makeup: number;
}

export interface DistortionState {
  enabled: boolean;
  /** 0..1 amount (maps to saturation curve intensity) */
  amount: number;
  /** 0..1 wet/dry blend */
  mix: number;
}

export interface ReverbState {
  enabled: boolean;
  /** 0..1 wet gain */
  mix: number;
  /** 0.3..4 seconds */
  size: number;
}

export interface DelayState {
  enabled: boolean;
  /** seconds, 0.02..1.5 */
  time: number;
  /** 0..0.95 feedback */
  feedback: number;
  /** 0..1 wet gain */
  mix: number;
}

export interface CassetteState {
  enabled: boolean;
  /** 6..16 bit quantisation */
  bitDepth: number;
  /** 1000..12000 Hz internal low-pass cutoff */
  cutoff: number;
  /** 0..0.003 tape noise amount */
  noise: number;
}

export interface EffectsState {
  eq: EQState;
  filter: FilterState;
  compressor: CompressorState;
  distortion: DistortionState;
  reverb: ReverbState;
  delay: DelayState;
  cassette: CassetteState;
}

export const defaultEffectsState: EffectsState = {
  eq: { enabled: false, bass: 0, mid: 0, treble: 0 },
  filter: { enabled: false, cutoff: 1, resonance: 1 },
  compressor: { enabled: false, mode: "native", makeup: 1 },
  distortion: { enabled: false, amount: 0.3, mix: 0.5 },
  reverb: { enabled: false, mix: 0.35, size: 1.5 },
  delay: { enabled: false, time: 0.38, feedback: 0.35, mix: 0.3 },
  cassette: { enabled: false, bitDepth: 12, cutoff: 5000, noise: 0.0004 },
};

export type PresetName = "clean" | "lofi" | "club" | "radio" | "dreamy" | "destroy";

export const effectsPresets: Record<PresetName, { label: string; description: string; state: EffectsState }> = {
  clean: {
    label: "Clean",
    description: "All effects off",
    state: defaultEffectsState,
  },
  lofi: {
    label: "Lo-Fi",
    description: "Warm compression, tape crunch, gentle delay",
    state: {
      eq: { enabled: true, bass: 2, mid: -1.5, treble: -4 },
      filter: { enabled: false, cutoff: 1, resonance: 1 },
      compressor: { enabled: true, mode: "warmTape", makeup: 1.1 },
      distortion: { enabled: false, amount: 0.3, mix: 0.3 },
      reverb: { enabled: true, mix: 0.2, size: 1.2 },
      delay: { enabled: true, time: 0.3, feedback: 0.25, mix: 0.2 },
      cassette: { enabled: true, bitDepth: 10, cutoff: 4000, noise: 0.0008 },
    },
  },
  club: {
    label: "Club",
    description: "Punchy bass, bright compression, subtle reverb",
    state: {
      eq: { enabled: true, bass: 4, mid: 0, treble: 2 },
      filter: { enabled: false, cutoff: 1, resonance: 1 },
      compressor: { enabled: true, mode: "brightOpen", makeup: 1.15 },
      distortion: { enabled: false, amount: 0.3, mix: 0.5 },
      reverb: { enabled: true, mix: 0.18, size: 0.8 },
      delay: { enabled: false, time: 0.38, feedback: 0.35, mix: 0.3 },
      cassette: { enabled: false, bitDepth: 12, cutoff: 5000, noise: 0.0004 },
    },
  },
  radio: {
    label: "Radio",
    description: "Mid-focused broadcast sound with bandpass",
    state: {
      eq: { enabled: true, bass: -6, mid: 4, treble: -2 },
      filter: { enabled: true, cutoff: 0.65, resonance: 1.5 },
      compressor: { enabled: true, mode: "native", makeup: 1.2 },
      distortion: { enabled: true, amount: 0.15, mix: 0.25 },
      reverb: { enabled: false, mix: 0.35, size: 1.5 },
      delay: { enabled: false, time: 0.38, feedback: 0.35, mix: 0.3 },
      cassette: { enabled: true, bitDepth: 8, cutoff: 3000, noise: 0.001 },
    },
  },
  dreamy: {
    label: "Dreamy",
    description: "Long reverb, slow delay, open space",
    state: {
      eq: { enabled: true, bass: 1, mid: -2, treble: 3 },
      filter: { enabled: false, cutoff: 1, resonance: 1 },
      compressor: { enabled: false, mode: "native", makeup: 1 },
      distortion: { enabled: false, amount: 0.3, mix: 0.5 },
      reverb: { enabled: true, mix: 0.55, size: 3.2 },
      delay: { enabled: true, time: 0.5, feedback: 0.5, mix: 0.35 },
      cassette: { enabled: false, bitDepth: 12, cutoff: 5000, noise: 0.0004 },
    },
  },
  destroy: {
    label: "Destroy",
    description: "Maximum crunch — drive, crush, feedback",
    state: {
      eq: { enabled: true, bass: 4, mid: 2, treble: -3 },
      filter: { enabled: true, cutoff: 0.55, resonance: 4 },
      compressor: { enabled: true, mode: "warmTape", makeup: 1.4 },
      distortion: { enabled: true, amount: 0.8, mix: 0.85 },
      reverb: { enabled: true, mix: 0.25, size: 1.5 },
      delay: { enabled: true, time: 0.25, feedback: 0.65, mix: 0.4 },
      cassette: { enabled: true, bitDepth: 7, cutoff: 2800, noise: 0.0015 },
    },
  },
};

const SMOOTH_TIME = 0.04;

function setGainSmooth(param: AudioParam, target: number, ctx: AudioContext) {
  param.setTargetAtTime(target, ctx.currentTime, SMOOTH_TIME);
}

function setParamSmooth(param: AudioParam, target: number, ctx: AudioContext, tc = SMOOTH_TIME) {
  param.setTargetAtTime(target, ctx.currentTime, tc);
}

// ---------------------------------------------------------------------------
// EQ (3-band shelving/peaking)
// ---------------------------------------------------------------------------
class EQ {
  readonly input: GainNode;
  readonly output: GainNode;
  private wet: GainNode;
  private dry: GainNode;
  private low: BiquadFilterNode;
  private mid: BiquadFilterNode;
  private high: BiquadFilterNode;
  private enabled = false;

  constructor(private ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.wet = ctx.createGain();
    this.dry = ctx.createGain();

    this.low = ctx.createBiquadFilter();
    this.low.type = "lowshelf";
    this.low.frequency.value = 180;

    this.mid = ctx.createBiquadFilter();
    this.mid.type = "peaking";
    this.mid.frequency.value = 1000;
    this.mid.Q.value = 0.8;

    this.high = ctx.createBiquadFilter();
    this.high.type = "highshelf";
    this.high.frequency.value = 5200;

    // Wet path: low -> mid -> high
    this.input.connect(this.low);
    this.low.connect(this.mid);
    this.mid.connect(this.high);
    this.high.connect(this.wet);
    this.wet.connect(this.output);

    // Dry bypass
    this.input.connect(this.dry);
    this.dry.connect(this.output);

    this.wet.gain.value = 0;
    this.dry.gain.value = 1;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    setGainSmooth(this.wet.gain, on ? 1 : 0, this.ctx);
    setGainSmooth(this.dry.gain, on ? 0 : 1, this.ctx);
  }

  setBass(gainDb: number) {
    setParamSmooth(this.low.gain, gainDb, this.ctx);
  }
  setMid(gainDb: number) {
    setParamSmooth(this.mid.gain, gainDb, this.ctx);
  }
  setTreble(gainDb: number) {
    setParamSmooth(this.high.gain, gainDb, this.ctx);
  }

  apply(state: EQState) {
    this.setEnabled(state.enabled);
    this.setBass(state.bass);
    this.setMid(state.mid);
    this.setTreble(state.treble);
  }

  dispose() {
    try {
      this.input.disconnect();
      this.low.disconnect();
      this.mid.disconnect();
      this.high.disconnect();
      this.wet.disconnect();
      this.dry.disconnect();
      this.output.disconnect();
    } catch (_) {}
  }

  get isEnabled() {
    return this.enabled;
  }
}

// ---------------------------------------------------------------------------
// Filter (DJ-style low-pass cutoff with resonance)
// ---------------------------------------------------------------------------
class Filter {
  readonly input: GainNode;
  readonly output: GainNode;
  private wet: GainNode;
  private dry: GainNode;
  private node: BiquadFilterNode;

  constructor(private ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.wet = ctx.createGain();
    this.dry = ctx.createGain();
    this.node = ctx.createBiquadFilter();
    this.node.type = "lowpass";
    this.node.frequency.value = 20000;
    this.node.Q.value = 1;

    this.input.connect(this.node);
    this.node.connect(this.wet);
    this.wet.connect(this.output);

    this.input.connect(this.dry);
    this.dry.connect(this.output);

    this.wet.gain.value = 0;
    this.dry.gain.value = 1;
  }

  setEnabled(on: boolean) {
    setGainSmooth(this.wet.gain, on ? 1 : 0, this.ctx);
    setGainSmooth(this.dry.gain, on ? 0 : 1, this.ctx);
  }

  /** cutoff: 0 = fully closed (~80Hz), 1 = fully open (20kHz, transparent) */
  setCutoff(normalized: number) {
    const clamped = Math.max(0, Math.min(1, normalized));
    // Exponential mapping so the sweep feels musical
    const minF = 80;
    const maxF = 20000;
    const freq = minF * Math.pow(maxF / minF, clamped);
    setParamSmooth(this.node.frequency, freq, this.ctx, 0.02);
  }

  setResonance(q: number) {
    setParamSmooth(this.node.Q, Math.max(0.0001, q), this.ctx);
  }

  apply(state: FilterState) {
    this.setEnabled(state.enabled);
    this.setCutoff(state.cutoff);
    this.setResonance(state.resonance);
  }

  dispose() {
    try {
      this.input.disconnect();
      this.node.disconnect();
      this.wet.disconnect();
      this.dry.disconnect();
      this.output.disconnect();
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Distortion (WaveShaper with amount + wet/dry mix)
// ---------------------------------------------------------------------------
function makeSaturationCurve(amount: number, length = 1024) {
  const curve = new Float32Array(length);
  const a = Math.max(0.0001, amount);
  for (let i = 0; i < length; i++) {
    const x = (i * 2) / length - 1;
    curve[i] = ((1 + a) * x) / (1 + a * Math.abs(x));
  }
  return curve;
}

class Distortion {
  readonly input: GainNode;
  readonly output: GainNode;
  private shaper: WaveShaperNode;
  private wet: GainNode;
  private dry: GainNode;
  private enabled = false;
  private lastMix = 0.5;

  constructor(private ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.wet = ctx.createGain();
    this.dry = ctx.createGain();

    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = makeSaturationCurve(0.3);
    this.shaper.oversample = "2x";

    // Wet path: input -> shaper -> wet gain -> output
    this.input.connect(this.shaper);
    this.shaper.connect(this.wet);
    this.wet.connect(this.output);

    // Dry path: input -> dry gain -> output
    this.input.connect(this.dry);
    this.dry.connect(this.output);

    // Default state: fully dry so signal passes through unchanged
    this.wet.gain.value = 0;
    this.dry.gain.value = 1;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (on) {
      setGainSmooth(this.wet.gain, this.lastMix, this.ctx);
      setGainSmooth(this.dry.gain, 1 - this.lastMix, this.ctx);
    } else {
      setGainSmooth(this.wet.gain, 0, this.ctx);
      setGainSmooth(this.dry.gain, 1, this.ctx);
    }
  }

  setAmount(amount: number) {
    const curveAmt = 0.5 + amount * 25;
    this.shaper.curve = makeSaturationCurve(curveAmt);
  }

  setMix(mix: number) {
    this.lastMix = Math.max(0, Math.min(1, mix));
    if (this.enabled) {
      setGainSmooth(this.wet.gain, this.lastMix, this.ctx);
      setGainSmooth(this.dry.gain, 1 - this.lastMix, this.ctx);
    }
  }

  apply(state: DistortionState) {
    this.setAmount(state.amount);
    this.setMix(state.mix);
    this.setEnabled(state.enabled);
  }

  dispose() {
    try {
      this.input.disconnect();
      this.shaper.disconnect();
      this.wet.disconnect();
      this.dry.disconnect();
      this.output.disconnect();
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Compressor (with native / warm tape / bright open character modes)
// ---------------------------------------------------------------------------
class Compressor {
  readonly input: GainNode;
  readonly output: GainNode;
  private comp: DynamicsCompressorNode;
  private postGain: GainNode;
  private tone: BiquadFilterNode; // extra high-shelf used for bright mode
  private saturator: WaveShaperNode; // used for warm tape mode
  private wet: GainNode;
  private dry: GainNode;
  private currentMode: CompressorMode = "native";

  constructor(private ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.wet = ctx.createGain();
    this.dry = ctx.createGain();
    this.postGain = ctx.createGain();
    this.postGain.gain.value = 1;

    this.comp = ctx.createDynamicsCompressor();
    this.saturator = ctx.createWaveShaper();
    this.saturator.curve = makeSaturationCurve(3);
    this.saturator.oversample = "2x";
    this.tone = ctx.createBiquadFilter();
    this.tone.type = "highshelf";
    this.tone.frequency.value = 4000;
    this.tone.gain.value = 0;

    // Wet chain: input -> compressor -> saturator -> tone -> postGain -> wet
    this.input.connect(this.comp);
    this.comp.connect(this.saturator);
    this.saturator.connect(this.tone);
    this.tone.connect(this.postGain);
    this.postGain.connect(this.wet);
    this.wet.connect(this.output);

    // Dry bypass
    this.input.connect(this.dry);
    this.dry.connect(this.output);

    this.wet.gain.value = 0;
    this.dry.gain.value = 1;

    this.setMode("native");
  }

  setEnabled(on: boolean) {
    setGainSmooth(this.wet.gain, on ? 1 : 0, this.ctx);
    setGainSmooth(this.dry.gain, on ? 0 : 1, this.ctx);
  }

  setMode(mode: CompressorMode) {
    this.currentMode = mode;
    const now = this.ctx.currentTime;
    const set = (param: AudioParam, value: number) => {
      param.cancelScheduledValues(now);
      param.setTargetAtTime(value, now, 0.05);
    };

    switch (mode) {
      case "native":
        set(this.comp.threshold, -24);
        set(this.comp.knee, 6);
        set(this.comp.ratio, 4);
        set(this.comp.attack, 0.008);
        set(this.comp.release, 0.2);
        this.saturator.curve = makeSaturationCurve(0.5);
        set(this.tone.gain, 0);
        break;
      case "warmTape":
        set(this.comp.threshold, -18);
        set(this.comp.knee, 10);
        set(this.comp.ratio, 6);
        set(this.comp.attack, 0.0015);
        set(this.comp.release, 0.35);
        this.saturator.curve = makeSaturationCurve(8);
        set(this.tone.gain, -1);
        break;
      case "brightOpen":
        set(this.comp.threshold, -30);
        set(this.comp.knee, 2);
        set(this.comp.ratio, 12);
        set(this.comp.attack, 0.015);
        set(this.comp.release, 0.4);
        this.saturator.curve = makeSaturationCurve(2);
        set(this.tone.gain, 6);
        break;
    }
  }

  setMakeup(g: number) {
    setParamSmooth(this.postGain.gain, Math.max(0, g), this.ctx);
  }

  apply(state: CompressorState) {
    if (state.mode !== this.currentMode) this.setMode(state.mode);
    this.setMakeup(state.makeup);
    this.setEnabled(state.enabled);
  }

  dispose() {
    try {
      this.input.disconnect();
      this.comp.disconnect();
      this.saturator.disconnect();
      this.tone.disconnect();
      this.postGain.disconnect();
      this.wet.disconnect();
      this.dry.disconnect();
      this.output.disconnect();
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Reverb (convolver with generated IR, cached by size)
// ---------------------------------------------------------------------------
function generateReverbIR(ctx: BaseAudioContext, seconds = 1.5): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const chan = impulse.getChannelData(c);
    for (let i = 0; i < length; i++) {
      // Mild early-burst randomness with exponential decay
      const decay = Math.pow(1 - i / length, 3.5);
      chan[i] = (Math.random() * 2 - 1) * decay;
    }
  }
  return impulse;
}

class Reverb {
  readonly input: GainNode;
  readonly output: GainNode;
  private conv: ConvolverNode;
  private wet: GainNode;
  private dry: GainNode;
  private preDelay: DelayNode;
  private lastSize = 1.5;
  private lastMix = 0.35;
  private enabled = false;

  constructor(private ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.wet = ctx.createGain();
    this.dry = ctx.createGain();

    this.preDelay = ctx.createDelay();
    this.preDelay.delayTime.value = 0.02;

    this.conv = ctx.createConvolver();
    this.conv.buffer = generateReverbIR(ctx, this.lastSize);

    // Dry path is always on at unity so disabling the reverb just pulls
    // wet down to silence without colouring the audio.
    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.dry.gain.value = 1;

    // Wet path
    this.input.connect(this.preDelay);
    this.preDelay.connect(this.conv);
    this.conv.connect(this.wet);
    this.wet.connect(this.output);
    this.wet.gain.value = 0;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    setGainSmooth(this.wet.gain, on ? this.lastMix : 0, this.ctx);
  }

  setMix(mix: number) {
    this.lastMix = Math.max(0, Math.min(1, mix));
    if (this.enabled) setGainSmooth(this.wet.gain, this.lastMix, this.ctx);
  }

  setSize(seconds: number) {
    const s = Math.max(0.2, Math.min(4, seconds));
    if (Math.abs(s - this.lastSize) < 0.05) return;
    this.lastSize = s;
    try {
      this.conv.buffer = generateReverbIR(this.ctx, s);
    } catch (_) {}
  }

  apply(state: ReverbState) {
    this.setSize(state.size);
    this.setMix(state.mix);
    this.setEnabled(state.enabled);
  }

  dispose() {
    try {
      this.input.disconnect();
      this.preDelay.disconnect();
      this.conv.disconnect();
      this.wet.disconnect();
      this.dry.disconnect();
      this.output.disconnect();
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Delay (with feedback and wet/dry mix)
// ---------------------------------------------------------------------------
class Delay {
  readonly input: GainNode;
  readonly output: GainNode;
  private delay: DelayNode;
  private feedback: GainNode;
  private wet: GainNode;
  private dry: GainNode;
  private damp: BiquadFilterNode;

  constructor(private ctx: AudioContext, maxDelaySeconds = 2) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.wet = ctx.createGain();
    this.dry = ctx.createGain();
    this.delay = ctx.createDelay(maxDelaySeconds);
    this.feedback = ctx.createGain();
    this.feedback.gain.value = 0;

    this.damp = ctx.createBiquadFilter();
    this.damp.type = "lowpass";
    this.damp.frequency.value = 3200;
    this.damp.Q.value = 0.5;

    // Dry path
    this.input.connect(this.dry);
    this.dry.connect(this.output);

    // Wet path with feedback loop
    this.input.connect(this.delay);
    this.delay.connect(this.damp);
    this.damp.connect(this.feedback);
    this.feedback.connect(this.delay);
    this.damp.connect(this.wet);
    this.wet.connect(this.output);

    this.wet.gain.value = 0;
    this.dry.gain.value = 1;
  }

  setEnabled(on: boolean) {
    setGainSmooth(this.wet.gain, on ? this.lastMix : 0, this.ctx);
    setGainSmooth(this.dry.gain, 1, this.ctx);
    if (!on) {
      // Kill feedback trail too
      setGainSmooth(this.feedback.gain, 0, this.ctx);
    } else {
      setGainSmooth(this.feedback.gain, this.lastFeedback, this.ctx);
    }
  }

  private lastMix = 0;
  private lastFeedback = 0;

  setTime(seconds: number) {
    const t = Math.max(0.01, Math.min(2, seconds));
    setParamSmooth(this.delay.delayTime, t, this.ctx, 0.08);
  }

  setFeedback(fb: number) {
    this.lastFeedback = Math.max(0, Math.min(0.95, fb));
    setParamSmooth(this.feedback.gain, this.lastFeedback, this.ctx);
  }

  setMix(mix: number) {
    this.lastMix = Math.max(0, Math.min(1, mix));
    setGainSmooth(this.wet.gain, this.lastMix, this.ctx);
  }

  apply(state: DelayState) {
    this.setTime(state.time);
    this.setFeedback(state.feedback);
    this.setMix(state.mix);
    this.setEnabled(state.enabled);
  }

  dispose() {
    try {
      this.input.disconnect();
      this.delay.disconnect();
      this.damp.disconnect();
      this.feedback.disconnect();
      this.wet.disconnect();
      this.dry.disconnect();
      this.output.disconnect();
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Cassette (AudioWorklet-backed lo-fi processor; lazy-loaded)
// ---------------------------------------------------------------------------
let cassetteWorkletLoaded = false;
async function loadCassetteWorklet(ctx: AudioContext) {
  if (cassetteWorkletLoaded) return;
  if (!ctx.audioWorklet) throw new Error("AudioWorklet not supported");
  await ctx.audioWorklet.addModule("/worklets/cassette-processor-worklet.js");
  cassetteWorkletLoaded = true;
}

class Cassette {
  readonly input: GainNode;
  readonly output: GainNode;
  private node: AudioWorkletNode | null = null;
  private bypass: GainNode; // straight passthrough when not loaded
  private loadingPromise: Promise<void> | null = null;
  private pendingState: CassetteState | null = null;

  constructor(private ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.bypass = ctx.createGain();
    this.bypass.gain.value = 1;
    this.input.connect(this.bypass);
    this.bypass.connect(this.output);
  }

  private async ensureWorklet() {
    if (this.node) return;
    if (!this.loadingPromise) {
      this.loadingPromise = loadCassetteWorklet(this.ctx).then(() => {
        this.node = new AudioWorkletNode(this.ctx, "cassette-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        // Reroute: input -> node -> output, remove bypass path
        try { this.input.disconnect(this.bypass); } catch (_) {}
        this.input.connect(this.node);
        this.node.connect(this.output);
        // Apply any state that came in while we were loading.
        if (this.pendingState) {
          this.applyToNode(this.pendingState);
        }
      }).catch((err) => {
        // Fall back to bypass; clear the promise so future calls can retry.
        this.loadingPromise = null;
        console.warn("[Cassette] worklet load failed; using bypass", err);
      });
    }
    return this.loadingPromise;
  }

  private applyToNode(state: CassetteState) {
    if (!this.node) return;
    this.node.port.postMessage({
      active: state.enabled,
      bitDepth: state.bitDepth,
      cutoff: state.cutoff,
      noiseAmp: state.noise,
    });
  }

  apply(state: CassetteState) {
    this.pendingState = state;
    if (!state.enabled && !this.node) return; // nothing to do if never used
    this.ensureWorklet()?.then(() => this.applyToNode(state));
    if (this.node) this.applyToNode(state);
  }

  dispose() {
    try {
      this.input.disconnect();
      if (this.node) this.node.disconnect();
      this.bypass.disconnect();
      this.output.disconnect();
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Full effects chain wrapper
// ---------------------------------------------------------------------------
export class EffectsChain {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly eq: EQ;
  readonly filter: Filter;
  readonly distortion: Distortion;
  readonly compressor: Compressor;
  readonly reverb: Reverb;
  readonly delay: Delay;
  readonly cassette: Cassette;
  private masterOut: GainNode;

  constructor(private ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.masterOut = ctx.createGain();

    this.eq = new EQ(ctx);
    this.filter = new Filter(ctx);
    this.distortion = new Distortion(ctx);
    this.compressor = new Compressor(ctx);
    this.reverb = new Reverb(ctx);
    this.delay = new Delay(ctx);
    this.cassette = new Cassette(ctx);

    // Chain everything serially.
    this.input.connect(this.eq.input);
    this.eq.output.connect(this.filter.input);
    this.filter.output.connect(this.distortion.input);
    this.distortion.output.connect(this.compressor.input);
    this.compressor.output.connect(this.reverb.input);
    this.reverb.output.connect(this.delay.input);
    this.delay.output.connect(this.cassette.input);
    this.cassette.output.connect(this.masterOut);
    this.masterOut.connect(this.output);
  }

  apply(state: EffectsState) {
    this.eq.apply(state.eq);
    this.filter.apply(state.filter);
    this.distortion.apply(state.distortion);
    this.compressor.apply(state.compressor);
    this.reverb.apply(state.reverb);
    this.delay.apply(state.delay);
    this.cassette.apply(state.cassette);
  }

  setMasterGain(gain: number) {
    setGainSmooth(this.masterOut.gain, Math.max(0, gain), this.ctx);
  }

  /**
   * Best-effort eager preload of the cassette worklet so the first
   * activation doesn't have to wait for the module to fetch + compile.
   */
  async preload() {
    try {
      await loadCassetteWorklet(this.ctx);
    } catch (_) {
      /* silently fall back to bypass */
    }
  }

  dispose() {
    this.eq.dispose();
    this.filter.dispose();
    this.distortion.dispose();
    this.compressor.dispose();
    this.reverb.dispose();
    this.delay.dispose();
    this.cassette.dispose();
    try {
      this.input.disconnect();
      this.masterOut.disconnect();
      this.output.disconnect();
    } catch (_) {}
  }
}

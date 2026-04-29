# Infinite Jukebox

Infinite Jukebox is a Next.js web app that turns a song into a continuous stream by detecting beat similarity and jumping between matching sections.

## Features

- Upload local audio files in formats like MP3, WAV, FLAC and OGG
- Analyze beats in the browser
- Build an orbital beat map visualization (DPR-aware Canvas, mobile + desktop)
- Control jump behavior with playback settings (probability + cooldown)
- **Click-free crossfaded jumps** between similar beats
- **Master volume + mute** with click-free fade
- **Audio effects rack** (inspired by YouTube Beatmaker Cues):
  - **3-Band EQ** — bass / mid / treble shelving + peaking filters
  - **DJ Filter** — exponential low-pass cutoff sweep with adjustable resonance
  - **Drive** — waveshaper saturation with wet/dry mix
  - **Compressor** — three character modes: `Native`, `Warm Tape` (SP-303 style), `Bright` (SP-404 style)
  - **Reverb** — convolution reverb with adjustable size + pre-delay
  - **Delay** — feedback delay with high-end damping
  - **Cassette** — `AudioWorklet`-backed lo-fi: bit reduction, sample-rate crush, tape noise
- **Quick presets** — `Clean`, `Lo-Fi`, `Club`, `Radio`, `Dreamy`, `Destroy`

## Tech Stack

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS 4
- Web Audio API (`BiquadFilter`, `DynamicsCompressor`, `Convolver`, `WaveShaper`, `Delay`, `AudioWorklet`)

## Getting Started

1. Install dependencies:
   `npm install`
2. Start the development server:
   `npm run dev`
3. Open `http://localhost:3000` in your browser.

## Scripts

- `npm run dev` starts local development
- `npm run build` creates a production build
- `npm run start` runs the production server
- `npm run lint` runs lint checks

## Audio Architecture

The audio engine routes the decoded buffer through a serial effects chain:

```
source → fade gain → EQ → Filter → Drive → Compressor → Reverb → Delay → Cassette → master gain → destination
```

Each effect exposes a `.input` / `.output` `AudioNode` pair plus an `apply(state)` method
that smoothly fades wet/dry gains via `setTargetAtTime` to keep parameter changes click-free.
The cassette processor lives in `public/worklets/cassette-processor-worklet.js` and is
loaded lazily via `audioWorklet.addModule(...)`.


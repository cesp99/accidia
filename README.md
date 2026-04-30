# Accidia

A native, cross-platform desktop music player with time-synced lyrics, a
studio-grade effects rack, and the Infinite Jukebox loop engine as an
optional feature — all in an ~11 MB single binary.

Built on **Go + Wails + React** with a transparent, blurred window backdrop
and the heavy lifting done in Go.

By **Eyed & Carlo Esposito**.

## Highlights

- **Universal format support** — MP3, FLAC, OGG Vorbis and WAV decode in
  pure Go; AAC, M4A, Opus, WMA, ALAC, AIFF, AC-3, MKA and anything else
  route through an on-demand ffmpeg sidecar. First time you open one of
  those files, Accidia offers to download a static ffmpeg (~80 MB, one-time)
  into the app cache — no admin, no system install required.
- **Native music library** — point it at a folder; Go scans tags, embedded
  cover art, and persists an index for instant subsequent launches.
- **Time-synced lyrics** from LRCLIB (free, CC0). Active line highlighted,
  auto-scrolled, clickable to seek. Falls back cleanly to plain-text
  lyrics or an empty state.
- **Infinite Jukebox mode** — optional loop engine that detects similar
  beats and jumps between them forever. Click-free crossfades.
- **Studio effects rack** (live, click-free):
  - 3-band shelving + peaking EQ
  - DJ-style low-pass filter with resonance
  - Waveshaper drive with wet/dry mix
  - Compressor with `Native`, `Warm Tape` (SP-303 style), `Bright` (SP-404 style)
  - Convolution reverb with adjustable size + pre-delay
  - Feedback delay with high-end damping
  - Cassette `AudioWorklet`: bit-crush, sample-rate reduction, tape noise
  - Quick presets: `Clean`, `Lo-Fi`, `Club`, `Radio`, `Dreamy`, `Destroy`
- **Beautiful chrome**:
  - Frameless window with a custom drag region
  - Mica backdrop on Windows 11, vibrancy on macOS, alpha on composited Linux
  - Current cover art rendered as a slow-panning, heavily blurred wallpaper

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      WebView (React + Tailwind)                 │
│  ┌─ UI / Layout / Animations / Blur                              │
│  ├─ Beat analysis (energy envelope + cosine similarity)          │
│  └─ Web Audio engine (effects rack + AudioWorklet cassette)      │
│                                                                 │
│  ⇅  Wails IPC                                                   │
│                                                                 │
│  ┌─ Go (heavy lifting, tiny CPU/RAM cost)                        │
│  ├─ Library scan + tag/coverart extraction (dhowden/tag)         │
│  ├─ Native decoders: MP3 / FLAC / OGG / WAV → WAV                │
│  ├─ ffmpeg sidecar for any other format (lazy download)          │
│  ├─ Lyrics lookup (LRCLIB)                                       │
│  ├─ Persistent settings + library cache                          │
│  └─ Native dialogs, window control, OS integration               │
└─────────────────────────────────────────────────────────────────┘
```

| Layer | Where it runs | Language |
|---|---|---|
| UI, animations, blurred backdrop | WebView | React + Tailwind v4 |
| Audio playback + effects rack | WebView | Web Audio API + AudioWorklet |
| Beat analysis | WebView | TypeScript |
| MP3 / FLAC / OGG / WAV decode | Native | Go (pure) |
| AAC / M4A / Opus / WMA / ALAC decode | Native | Go → ffmpeg sidecar |
| Library scan, tags, cover art | Native | Go (`dhowden/tag`) |
| Time-synced lyrics | Native | Go (LRCLIB HTTP) |
| Settings + cache persistence | Native | Go |
| Window, file dialogs, drag region | Native | Go (`wailsapp/wails/v2`) |

## Getting started

### Prerequisites

- Go 1.23+
- Node 20+
- Wails CLI: `go install github.com/wailsapp/wails/v2/cmd/wails@latest`
- **Linux only** — you need these runtime packages (not just the `-dev` variants):
  | Distro | Install |
  |---|---|
  | Arch | `sudo pacman -S gtk3 webkit2gtk-4.1 gst-plugins-good gst-plugins-bad` |
  | Debian / Ubuntu | `sudo apt install libgtk-3-dev libwebkit2gtk-4.1-dev gstreamer1.0-plugins-good gstreamer1.0-plugins-bad` |
  | Fedora | `sudo dnf install gtk3-devel webkit2gtk4.1-devel gstreamer1-plugins-good gstreamer1-plugins-bad-free` |

  > ⚠️ `gst-plugins-good` is **required** — without it WebKit2GTK can't build
  > its Web Audio output pipeline, and playback silently fails with
  > `Decoding failed`. Accidia runs a startup health check and will surface
  > a fix hint at the top of the window if it detects missing plugins.
- ffmpeg is **optional** — Accidia will offer to download a static build
  the first time you open a non-native format (AAC, M4A, Opus, WMA…).

### Develop

```bash
wails dev -tags webkit2_41   # Linux (WebKitGTK 4.1)
wails dev                    # macOS / Windows
```

### Build a single-file binary

```bash
wails build -tags webkit2_41             # Linux
wails build                              # macOS / Windows
wails build -nsis                        # Windows + NSIS installer
wails build -platform darwin/universal   # Universal Mac
```

Output: `build/bin/accidia` (or `.app` / `.exe`).

### Cross-platform release via CI

Push a tag like `v0.1.0`; `.github/workflows/release.yml` runs the matrix
build on Ubuntu, macOS and Windows runners and uploads:

- `accidia` (Linux binary, ~11 MB)
- `Accidia.app` + `accidia.dmg` (macOS universal)
- `accidia.exe` + NSIS installer (Windows)

## Project layout

```
.
├── main.go                 # Wails options (transparency, vibrancy, mica)
├── app.go                  # Bound Go ↔ JS API surface
├── library.go              # Tag scan, cover art, in-memory + on-disk cache
├── decoder.go              # Native MP3/FLAC/OGG/WAV decoders
├── ffmpeg.go               # On-demand ffmpeg sidecar for every other format
├── lyrics.go               # LRCLIB time-synced lyrics
├── settings.go             # JSON-backed settings store
├── *_test.go               # Go tests (decoder, ffmpeg, extraction, LRC)
├── wails.json              # Wails project config
├── build/
│   └── appicon.png
├── frontend/
│   ├── package.json        # Vite + React 19 + Tailwind 4
│   ├── index.html
│   ├── vite.config.ts
│   ├── public/worklets/    # AudioWorklet sources (cassette processor)
│   ├── src/
│   │   ├── App.tsx
│   │   ├── globals.css
│   │   ├── components/
│   │   │   ├── shell/      # titlebar, sidebar, player bar, blurred bg,
│   │   │   │               # now-playing, lyrics, ffmpeg-dialog
│   │   │   ├── library/    # library view, track list, album cards
│   │   │   ├── jukebox/    # beat circle, effects panel, original controls
│   │   │   └── ui/         # primitives (slider…)
│   │   ├── hooks/use-audio-engine.ts
│   │   └── lib/audio-effects.ts, audio-analysis.ts, utils.ts
│   └── wailsjs/            # auto-generated Go bindings (gitignored)
└── .github/workflows/release.yml
```

## Window transparency notes

- **Windows 11**: Mica backdrop via `windows.BackdropType: Mica`. Falls back
  to acrylic on Win10.
- **macOS**: Native vibrancy via `mac.WindowIsTranslucent`. Traffic lights
  are preserved in the original position; 78px is reserved on the left of
  the custom titlebar to avoid overlap.
- **Linux**: Alpha works whenever your compositor allows it (Mutter, KWin,
  Hyprland, Sway). KWin and Hyprland apply blur behind the transparent
  window; Mutter/Sway show the raw desktop through the tint.

## Credits

- Infinite Jukebox mode inspired by Paul Lamere's original.
- Effects rack design adapted from the YouTube Beatmaker Cues extension
  (owae.ga), re-implemented on pure Web Audio + AudioWorklet.
- Lyrics from [LRCLIB](https://lrclib.net) — a free, CC0-licensed database.
- Static ffmpeg builds from
  [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (Linux/Windows)
  and [evermeet.cx](https://evermeet.cx/ffmpeg/) (macOS).

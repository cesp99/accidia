import { Disc3, Github, Music2 } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { BrowserOpenURL } from "../../../wailsjs/runtime/runtime";

interface SettingsViewProps {
  /**
   * Persisted backdrop opacity. `null` while settings are still
   * loading from disk — we render the slider at the default until
   * the real value lands. The Settings tab is gated behind the
   * normal user flow so this is rarely seen in practice, but we
   * keep the type honest so consumers don't have to coerce.
   */
  backdropOpacity: number | null;
  onBackdropOpacityChange: (value: number) => void;
  /** App version, pulled from the Go `HostInfo()` binding. */
  version?: string;
}

/**
 * Settings page. Two sections:
 *   1. Appearance — currently just the backdrop opacity slider
 *   2. About — credits + version
 */
export function SettingsView({
  backdropOpacity,
  onBackdropOpacityChange,
  version,
}: SettingsViewProps) {
  const value = backdropOpacity ?? 1;
  const pct = Math.round(value * 100);

  return (
    <div className="h-full overflow-y-auto scroll-thin px-8 py-6">
      <div className="mx-auto w-full max-w-2xl space-y-8">
        <header>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Preferences
          </p>
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Tune how the app looks on your desktop.
          </p>
        </header>

        {/* Appearance */}
        <section className="space-y-3">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Appearance
          </h2>
          <div className="space-y-4 rounded-xl border border-white/5 bg-white/[0.02] p-5 backdrop-blur-sm">
            <div>
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-medium text-foreground">Backdrop opacity</span>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {pct}%
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                How solid the app background is. Lower values let your desktop wallpaper
                show through the window for a glassy look; the album art stays at a fixed
                30% so text always remains readable.
              </p>
              <div className="mt-3">
                <Slider
                  min={0.1}
                  max={1}
                  step={0.01}
                  value={[value]}
                  onValueChange={([v]) => onBackdropOpacityChange(v)}
                  className="[&_[data-slot=slider-range]]:bg-white [&_[data-slot=slider-thumb]]:border-white [&_[data-slot=slider-thumb]]:bg-white"
                  aria-label="Backdrop opacity"
                />
              </div>
              <div className="mt-2 flex justify-between text-[10px] uppercase tracking-wider text-muted-foreground/60">
                <span>Transparent</span>
                <span>Solid</span>
              </div>
            </div>
          </div>
        </section>

        {/* About / credits */}
        <section className="space-y-3">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            About
          </h2>
          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-5 backdrop-blur-sm">
            <div className="flex items-start gap-4">
              <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-white/[0.04] border border-white/10">
                <Music2 size={24} className="text-foreground/80" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-lg font-bold tracking-tight text-foreground">
                    Accidia
                  </h3>
                  {version && (
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">
                      v{version}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  A native music player with the Infinite Jukebox loop engine.
                </p>
              </div>
            </div>

            {/* Credits grid */}
            <dl className="mt-5 grid gap-3 border-t border-white/5 pt-4 text-xs sm:grid-cols-[auto_1fr] sm:gap-x-5 sm:gap-y-3">
              <Credit
                label="Developer"
                name="Carlo Esposito"
                link="https://github.com/cesp99"
                linkIcon={<Github size={11} />}
              />
              <Credit
                label="Studio"
                name={
                  <>
                    Eyed®
                  </>
                }
                detail="Published under the Eyed® brand."
              />
              <Credit
                label="Infinite Jukebox"
                name="Paul Lamere"
                detail="Created the original Infinite Jukebox at The Echo Nest in 2012. The beat-graph looping algorithm in this app is a clean-room reimplementation of that concept."
                link="https://musicmachinery.com/2012/11/12/the-infinite-jukebox/"
                linkIcon={<Disc3 size={11} />}
                linkLabel="Read the original post"
              />
            </dl>

            <p className="mt-5 border-t border-white/5 pt-4 text-[11px] leading-relaxed text-muted-foreground/70">
              Lyrics provided by{" "}
              <button
                type="button"
                onClick={() => openExternal("https://lrclib.net")}
                className="text-foreground/90 underline-offset-2 hover:underline"
              >
                LRCLIB
              </button>{" "}
              under CC0. Built with Go, Wails, React, and Web Audio.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * Open a URL in the host OS's default browser. Inside a WebView
 * `<a target="_blank">` does nothing — we have to bounce through the
 * Wails runtime, which calls the platform's shell-open API.
 */
function openExternal(url: string) {
  try {
    BrowserOpenURL(url);
  } catch {
    // Running outside Wails (e.g. Vite dev mode in a regular browser).
    // Fall back to the standard window.open path; if that's blocked too,
    // there's nothing more we can do.
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function Credit({
  label,
  name,
  detail,
  link,
  linkLabel,
  linkIcon,
}: {
  label: string;
  name: React.ReactNode;
  detail?: string;
  link?: string;
  linkLabel?: string;
  linkIcon?: React.ReactNode;
}) {
  return (
    <>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground sm:pt-0.5">
        {label}
      </dt>
      <dd className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{name}</span>
          {link && (
            <button
              type="button"
              onClick={() => openExternal(link)}
              className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
            >
              {linkIcon}
              {linkLabel ?? "Open"}
            </button>
          )}
        </div>
        {detail && (
          <p className="text-[11px] leading-relaxed text-muted-foreground/80">{detail}</p>
        )}
      </dd>
    </>
  );
}

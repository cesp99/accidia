import { useEffect, useState } from "react";
import { Download, Loader2, CheckCircle2, AlertCircle, Package } from "lucide-react";
import { cn } from "@/lib/utils";
import { InstallFFmpeg } from "../../../wailsjs/go/main/App";
import { EventsOn } from "../../../wailsjs/runtime/runtime";

interface InstallProgressEvent {
  stage: string;
  got: number;
  total: number;
}

interface FFmpegDialogProps {
  open: boolean;
  trackName: string;
  onCancel: () => void;
  /** Called once installation completes successfully. */
  onInstalled: () => void;
}

/**
 * Modal shown when the user tries to play a format that needs ffmpeg and
 * no ffmpeg binary has been located yet. Kicks off the Go-side download,
 * listens for `ffmpeg:progress` events and resolves/rejects cleanly.
 */
export function FFmpegDialog({ open, trackName, onCancel, onInstalled }: FFmpegDialogProps) {
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<InstallProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setInstalling(false);
      setProgress(null);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    return EventsOn("ffmpeg:progress", (...args: unknown[]) => {
      setProgress(args[0] as InstallProgressEvent);
    });
  }, []);

  const handleInstall = async () => {
    setError(null);
    setInstalling(true);
    try {
      await InstallFFmpeg();
      onInstalled();
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(false);
    }
  };

  if (!open) return null;

  const pct =
    progress && progress.total > 0 ? (progress.got / progress.total) * 100 : null;
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-md"
        onClick={installing ? undefined : onCancel}
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "relative w-full max-w-lg rounded-2xl p-6 space-y-5 animate-fade-in",
          "glass-strong shadow-2xl",
        )}
      >
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/15 border border-primary/30">
            <Package size={22} className="text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-foreground">
              One-time codec install
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Accidia plays MP3, FLAC, OGG and WAV natively. To also play{" "}
              <span className="text-foreground font-medium">{trackName}</span>{" "}
              and every other format (AAC, M4A, Opus, WMA, ALAC, AIFF…) we'll
              download a small static ffmpeg build into your app cache.
            </p>
          </div>
        </div>

        <ul className="space-y-2 rounded-xl border border-white/8 bg-white/3 p-3 text-xs">
          <li className="flex items-center gap-2 text-muted-foreground">
            <CheckCircle2 size={12} className="text-primary" />
            One-time ~80 MB download (cached for every future launch)
          </li>
          <li className="flex items-center gap-2 text-muted-foreground">
            <CheckCircle2 size={12} className="text-primary" />
            Stored in your OS cache dir — never modifies system ffmpeg
          </li>
          <li className="flex items-center gap-2 text-muted-foreground">
            <CheckCircle2 size={12} className="text-primary" />
            Static binary, no admin rights needed
          </li>
        </ul>

        {installing && (
          <div className="space-y-2 rounded-xl border border-primary/20 bg-primary/5 p-3">
            <div className="flex items-center gap-2 text-xs text-primary">
              <Loader2 size={12} className="animate-spin" />
              <span className="font-medium">{progress?.stage ?? "Starting…"}</span>
              <span className="ml-auto font-mono tabular-nums">
                {progress && progress.total > 0
                  ? `${mb(progress.got)} / ${mb(progress.total)} MB`
                  : progress && progress.got > 0
                  ? `${mb(progress.got)} MB`
                  : ""}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/8">
              {pct !== null ? (
                <div
                  className="h-full bg-primary transition-[width] duration-100"
                  style={{ width: `${pct}%` }}
                />
              ) : (
                <div className="h-full w-1/3 animate-slow-pan bg-primary/50" />
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive-foreground">
            <AlertCircle size={14} className="mt-0.5 shrink-0 text-destructive" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            disabled={installing}
            className={cn(
              "rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors",
              "hover:text-foreground hover:bg-white/5",
              "disabled:opacity-40 disabled:cursor-not-allowed",
            )}
          >
            Not now
          </button>
          <button
            type="button"
            onClick={handleInstall}
            disabled={installing}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold",
              "bg-primary text-primary-foreground shadow-lg shadow-primary/30",
              "hover:brightness-110 active:scale-[0.98] transition-all",
              "disabled:opacity-50 disabled:cursor-default",
            )}
          >
            {installing ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Installing…
              </>
            ) : (
              <>
                <Download size={14} />
                Install codecs
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

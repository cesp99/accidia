import { useEffect, useState } from "react";
import { FolderOpen, Loader2, Music2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { TrackList } from "./track-list";
import {
  GetLibrary,
  PickLibraryFolder,
  ScanLibrary,
} from "../../../wailsjs/go/main/App";
import { EventsOn } from "../../../wailsjs/runtime/runtime";
import type { main } from "../../../wailsjs/go/models";

interface LibraryViewProps {
  currentPath?: string;
  onPlay: (track: main.Track) => void;
}

interface ScanProgress {
  label: string;
  scanned: number;
  total: number;
}

export function LibraryView({ currentPath, onPlay }: LibraryViewProps) {
  const [library, setLibrary] = useState<main.LibraryScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Initial load: pull whatever's cached on disk so the UI fills instantly.
  useEffect(() => {
    GetLibrary()
      .then((res) => setLibrary(res))
      .catch((e) => setError(String(e)));
  }, []);

  // Subscribe to scan progress events emitted by Go's library scanner.
  useEffect(() => {
    return EventsOn("library:progress", (...args: unknown[]) => {
      const data = args[0] as ScanProgress;
      setProgress(data);
    });
  }, []);

  const handlePickFolder = async () => {
    setError(null);
    try {
      const path = await PickLibraryFolder();
      if (!path) return; // user cancelled
      setScanning(true);
      const result = await ScanLibrary(path);
      setLibrary(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
      setProgress(null);
    }
  };

  const handleRescan = async () => {
    if (!library?.root) return;
    setError(null);
    setScanning(true);
    try {
      const result = await ScanLibrary(library.root);
      setLibrary(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
      setProgress(null);
    }
  };

  const tracks = library?.tracks ?? [];

  if (!library || tracks.length === 0) {
    return (
      <Welcome
        onPickFolder={handlePickFolder}
        scanning={scanning}
        progress={progress}
        error={error}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 px-6 pt-4">
        <div className="flex min-w-0 flex-col">
          <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Music folder
          </p>
          <p className="truncate font-mono text-xs text-foreground/70">{library.root}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={handleRescan}
            disabled={scanning}
            className={cn(
              "rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-muted-foreground",
              "transition-colors hover:bg-white/10 hover:text-foreground",
              "disabled:opacity-50",
            )}
          >
            {scanning ? "Rescanning…" : "Rescan"}
          </button>
          <button
            type="button"
            onClick={handlePickFolder}
            disabled={scanning}
            className={cn(
              "rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-muted-foreground",
              "transition-colors hover:bg-white/10 hover:text-foreground",
              "disabled:opacity-50",
            )}
          >
            Change folder
          </button>
        </div>
      </div>
      {scanning && progress && (
        <ScanBar progress={progress} />
      )}
      {error && <p className="px-6 pt-2 text-xs text-destructive">{error}</p>}
      <div className="min-h-0 flex-1">
        <TrackList tracks={tracks} currentPath={currentPath} onPlay={onPlay} />
      </div>
    </div>
  );
}

function ScanBar({ progress }: { progress: ScanProgress }) {
  const pct = progress.total > 0 ? (progress.scanned / progress.total) * 100 : 0;
  return (
    <div className="px-6 pt-3">
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
        <div className="flex items-center gap-2 text-xs text-primary">
          <Loader2 size={12} className="animate-spin" />
          <span className="font-medium">{progress.label}</span>
          <span className="ml-auto font-mono tabular-nums">
            {progress.scanned}/{progress.total || "?"}
          </span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/8">
          <div
            className="h-full bg-primary transition-[width] duration-100"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function Welcome({
  onPickFolder,
  scanning,
  progress,
  error,
}: {
  onPickFolder: () => void;
  scanning: boolean;
  progress: ScanProgress | null;
  error: string | null;
}) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="w-full max-w-md space-y-8 text-center animate-fade-in">
        <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-white/5">
          <Music2 size={26} className="text-foreground/80" />
        </div>
        <div className="space-y-3">
          <h1 className="text-3xl font-bold tracking-tight text-balance">
            Your music, beautifully.
          </h1>
          <p className="mx-auto max-w-sm text-sm leading-relaxed text-muted-foreground">
            Point the player at a folder of music. We'll read tags, fetch cover art,
            and let you optionally loop tracks forever via the Infinite Jukebox engine.
          </p>
        </div>

        <button
          type="button"
          onClick={onPickFolder}
          disabled={scanning}
          className={cn(
            "inline-flex items-center gap-2 rounded-full px-5 py-2.5",
            "bg-white text-black font-semibold shadow-[0_2px_12px_rgba(0,0,0,0.35)]",
            "transition-all hover:brightness-95 active:scale-[0.98]",
            "disabled:opacity-50 disabled:cursor-default",
          )}
        >
          {scanning ? (
            <>
              <Loader2 size={15} className="animate-spin" />
              Scanning…
            </>
          ) : (
            <>
              <FolderOpen size={15} />
              Choose music folder
            </>
          )}
        </button>

        {scanning && progress && (
          <p className="text-xs text-muted-foreground">
            {progress.label}{" "}
            <span className="font-mono">
              ({progress.scanned}/{progress.total || "?"})
            </span>
          </p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
        <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground/60">
          MP3 · FLAC · WAV · OGG · M4A · AAC · OPUS
        </p>
      </div>
    </div>
  );
}

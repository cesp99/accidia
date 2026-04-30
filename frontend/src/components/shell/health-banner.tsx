import { useEffect, useState } from "react";
import { AlertTriangle, X, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { RunHealthCheck } from "../../../wailsjs/go/main/App";
import type { health } from "../../../wailsjs/go/models";

/**
 * A non-blocking startup banner that shows when the Go-side health check
 * detects something that would otherwise manifest as an opaque audio
 * failure later. The most common hit is on Linux: WebKit2GTK needs
 * gst-plugins-good for Web Audio, and a lot of distros don't install it
 * by default.
 */
export function HealthBanner() {
  const [hc, setHc] = useState<health.Check | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    RunHealthCheck()
      .then(setHc)
      .catch(() => {
        /* silent: health is diagnostic, not required */
      });
  }, []);

  if (!hc || hc.ok || dismissed || !hc.issues || hc.issues.length === 0) {
    return null;
  }

  const copy = () => {
    const txt = hc.issues!
      .map((i) => `${i.title}\n\n${i.detail}\n\nFix: ${i.fix}`)
      .join("\n\n---\n\n");
    navigator.clipboard?.writeText(txt).catch(() => {});
  };

  return (
    <div className="z-20 mx-auto mt-2 max-w-2xl space-y-2">
      {hc.issues.map((issue) => (
        <div
          key={issue.id}
          role="alert"
          className={cn(
            "rounded-lg border px-3 py-3 text-xs backdrop-blur",
            issue.severity === "error"
              ? "border-destructive/30 bg-destructive/15 text-destructive-foreground"
              : "border-accent/30 bg-accent/15 text-accent-foreground",
          )}
        >
          <div className="flex items-start gap-2">
            <AlertTriangle
              size={14}
              className={cn(
                "mt-0.5 shrink-0",
                issue.severity === "error" ? "text-destructive" : "text-accent",
              )}
            />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-sm font-semibold">{issue.title}</p>
              <p className="text-muted-foreground leading-relaxed">{issue.detail}</p>
              {issue.fix && (
                <pre className="rounded border border-white/10 bg-black/30 px-2 py-1 font-mono text-[11px] whitespace-pre-wrap">
                  {issue.fix}
                </pre>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <button
                type="button"
                onClick={copy}
                className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wider hover:bg-white/10"
                title="Copy fix to clipboard"
              >
                <Copy size={10} /> Copy
              </button>
              <button
                type="button"
                onClick={() => setDismissed(true)}
                className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wider hover:bg-white/10"
                title="Dismiss for this session"
              >
                <X size={10} /> Dismiss
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

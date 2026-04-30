import { useRef, useCallback, useState } from "react";
import { Upload, Loader2, Music } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AnalysisData } from "@/hooks/use-audio-engine";
import { analyzeAudioFile } from "@/lib/audio-analysis";

interface UploadFormProps {
  onAnalysisComplete: (file: File, data: AnalysisData) => void;
  onError: (msg: string) => void;
  isLoading: boolean;
  setIsLoading: (v: boolean) => void;
}

export function UploadForm({
  onAnalysisComplete,
  onError,
  isLoading,
  setIsLoading,
}: UploadFormProps) {
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = useCallback(
    async (file: File) => {
      setIsLoading(true);
      onError("");
      try {
        const data = await analyzeAudioFile(file);
        onAnalysisComplete(file, data);
      } catch (e: unknown) {
        onError(e instanceof Error ? e.message : "Something went wrong");
      } finally {
        setIsLoading(false);
      }
    },
    [onAnalysisComplete, onError, setIsLoading]
  );

  const handleFile = (file: File) => {
    setFileName(file.name);
    submit(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  return (
    <div className="w-full max-w-lg mx-auto">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => !isLoading && inputRef.current?.click()}
        className={cn(
          "relative border-2 border-dashed rounded-2xl p-12 flex flex-col items-center justify-center gap-4 transition-all",
          isLoading
            ? "cursor-default border-primary/40 bg-primary/5"
            : "cursor-pointer hover:border-primary/60 hover:bg-primary/5",
          dragOver
            ? "border-primary bg-primary/10 scale-[1.01]"
            : "border-border/50 bg-card/60"
        )}
      >
        {isLoading ? (
          <>
            <div className="w-14 h-14 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center">
              <Loader2 size={26} className="text-primary animate-spin" />
            </div>
            <div className="text-center space-y-1">
              <p className="text-sm font-medium text-foreground">Analyzing audio...</p>
              <p className="text-xs text-muted-foreground">Detecting beats and finding patterns</p>
            </div>
            <div className="flex gap-1.5">
              {[0, 1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce"
                  style={{ animationDelay: `${i * 0.1}s` }}
                />
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="w-14 h-14 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
              {fileName ? <Music size={26} className="text-primary" /> : <Upload size={26} className="text-primary" />}
            </div>
            {fileName ? (
              <div className="text-center space-y-1">
                <p className="text-sm font-semibold text-foreground truncate max-w-xs">{fileName}</p>
                <p className="text-xs text-muted-foreground">Click or drop to change file</p>
              </div>
            ) : (
              <div className="text-center space-y-1">
                <p className="text-sm font-semibold text-foreground">Drop an audio file here</p>
                <p className="text-xs text-muted-foreground">or click to browse</p>
              </div>
            )}
            <p className="text-xs text-muted-foreground/70 mt-1">
              MP3 &middot; WAV &middot; FLAC &middot; AAC &middot; OGG
            </p>
          </>
        )}

        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
      </div>
    </div>
  );
}

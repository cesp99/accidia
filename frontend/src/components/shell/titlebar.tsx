import { useEffect, useState } from "react";
import { Minus, Square, Maximize2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CloseWindow,
  MinimizeWindow,
  ToggleMaximizeWindow,
  IsMaximized,
} from "../../../wailsjs/go/main/App";

interface TitleBarProps {
  platform: string;
}

/**
 * Minimal titlebar — just the drag region plus window controls.
 * No app name is rendered here; the OS window title is the one and only
 * place the product name appears in the chrome.
 */
export function TitleBar({ platform }: TitleBarProps) {
  const [isMax, setIsMax] = useState(false);

  useEffect(() => {
    let t = 0;
    const tick = async () => {
      try {
        setIsMax(await IsMaximized());
      } catch {
        /* Wails not attached (plain browser dev mode) */
      }
      t = window.setTimeout(tick, 1000) as unknown as number;
    };
    tick();
    return () => clearTimeout(t);
  }, []);

  const isMac = platform === "darwin";

  return (
    <div
      data-wails-drag
      className="relative z-30 flex h-9 shrink-0 items-center select-none bg-transparent"
    >
      {/* macOS: reserve the 78px slot for system traffic lights. */}
      {isMac && <div className="w-[78px] shrink-0" />}

      {/* Keep a flexible spacer so the Win/Linux buttons stay on the right. */}
      <div className="flex-1" />

      {/* Windows & Linux: custom min/max/close. */}
      {!isMac && (
        <div data-wails-no-drag className="flex h-full shrink-0 items-stretch">
          <WindowButton onClick={MinimizeWindow} aria-label="Minimize">
            <Minus size={14} />
          </WindowButton>
          <WindowButton
            onClick={ToggleMaximizeWindow}
            aria-label={isMax ? "Restore" : "Maximize"}
          >
            {isMax ? <Square size={11} /> : <Maximize2 size={11} />}
          </WindowButton>
          <WindowButton onClick={CloseWindow} aria-label="Close" danger>
            <X size={14} />
          </WindowButton>
        </div>
      )}
    </div>
  );
}

function WindowButton({
  children,
  onClick,
  danger,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-full w-11 items-center justify-center transition-colors",
        "text-muted-foreground hover:text-foreground",
        danger
          ? "hover:bg-destructive/80 hover:text-destructive-foreground"
          : "hover:bg-white/6",
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

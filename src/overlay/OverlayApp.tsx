import { useEffect, useState } from "react";
import type { OverlayWaveform } from "../services/shortcut/overlayVisibility";
import { OverlayWaveformView } from "./OverlayWaveformView";

/**
 * Separate Tauri window UI — waveform only, no buttons/labels/timers.
 * Never steals focus; parent window is created focusable:false.
 */
export function OverlayApp() {
  const [waveform, setWaveform] = useState<OverlayWaveform>("silent");
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<{ waveform: OverlayWaveform }>(
          "overlay:waveform",
          (event) => {
            setWaveform(event.payload.waveform);
            setVisible(true);
          },
        );
      } catch {
        // Browser preview of overlay.html — stay on defaults.
      }
    })();
    return () => unlisten?.();
  }, []);

  if (!visible) return null;
  return <OverlayWaveformView waveform={waveform} />;
}

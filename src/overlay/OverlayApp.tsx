import { useEffect, useRef, useState } from "react";
import { toDisplayLevel, WAVEFORM_BARS } from "../components/Waveform";
import type { CaptureEvent } from "../services/capture/types";
import type { OverlayWaveform } from "../services/shortcut/overlayVisibility";
import { OverlayWaveformView } from "./OverlayWaveformView";

const emptyLevels = () => Array<number>(WAVEFORM_BARS).fill(0);

/** Separate, non-focusable Tauri window. Only level metadata crosses IPC. */
export function OverlayApp() {
  const [waveform, setWaveform] = useState<OverlayWaveform>("silent");
  const [levels, setLevels] = useState(emptyLevels);
  const waveformRef = useRef<OverlayWaveform>("silent");
  const sessionRef = useRef<{ generation: number; requestId: string } | null>(null);

  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const overlayUnlisten = await listen<{ waveform: OverlayWaveform }>(
          "overlay:waveform",
          (event) => {
            waveformRef.current = event.payload.waveform;
            setWaveform(event.payload.waveform);
            if (event.payload.waveform === "silent") {
              sessionRef.current = null;
              setLevels(emptyLevels());
            }
          },
        );
        if (disposed) overlayUnlisten();
        else unlisteners.push(overlayUnlisten);

        const captureUnlisten = await listen<CaptureEvent>(
          "capture:event",
          (event) => {
            const capture = event.payload;
            if (capture.kind === "capture-started") {
              sessionRef.current = {
                generation: capture.generation,
                requestId: capture.request_id,
              };
              setLevels(emptyLevels());
              return;
            }
            if (capture.kind !== "capture-level"
                || waveformRef.current === "processing") return;
            const session = sessionRef.current;
            if (session && (session.generation !== capture.generation
                || session.requestId !== capture.request_id)) return;
            if (!session) {
              sessionRef.current = {
                generation: capture.generation,
                requestId: capture.request_id,
              };
            }
            const level = toDisplayLevel(capture.level);
            setLevels((previous) => [...previous.slice(1), level]);
          },
        );
        if (disposed) captureUnlisten();
        else unlisteners.push(captureUnlisten);
      } catch {
        // Browser preview of overlay.html — stay on the idle display.
      }
    })();
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  return <OverlayWaveformView levels={levels} waveform={waveform} />;
}

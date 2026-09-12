/// React hook: exposes real-time capture state to components.
///
/// - Preserves `test-running` mode when `capture-started` arrives so the
///   UI never shows a confusing mode transition.
/// - Prevents duplicate starts via a `sessionActive` check.
/// - Handles `busy`, `capture-unavailable`, and other IPC errors as stable
///   error categories.
/// - Stale events after unmount are discarded via `mountedRef`.
/// - Unmount calls `stopCapture()` for window-teardown safety.
import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelCapture,
  isCaptureActive,
  listDevices,
  onCaptureEvent,
  queryPermission,
  requestPermission,
  startMicTest,
  stopCapture,
} from "./captureService";
import {
  isCaptureSessionActive,
  type CaptureState,
  type PermissionStatus,
} from "./types";

export interface UseCaptureStateResult {
  captureState: CaptureState;
  devices: string[];
  permissionStatus: PermissionStatus | null;
  requestMicPermission: () => void;
  runMicTest: (device?: string) => Promise<void>;
  stopMicTest: () => void;
}

export function useCaptureState(): UseCaptureStateResult {
  const [captureState, setCaptureState] =
    useState<CaptureState>({ kind: "idle" });
  const [devices, setDevices] = useState<string[]>([]);
  const [permissionStatus, setPermissionStatus] =
    useState<PermissionStatus | null>(null);

  const mountedRef = useRef(true);
  // Tracks the active session generation to correlate cancel.
  const generationRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;

    const subscription = onCaptureEvent((event) => {
      if (!mountedRef.current) return;

      switch (event.kind) {
        case "permission-status":
          setPermissionStatus(event.status);
          if (
            event.status !== "authorized"
          ) {
            setCaptureState((prev) =>
              prev.kind === "idle" ? prev : { kind: "idle" },
            );
          }
          break;

        case "capture-started":
          // Preserve test-running mode: only update device name.
          setCaptureState((prev) => {
            if (prev.kind === "test-running") {
              // Keep mode, update device name would require a new field;
              // the mode is preserved as-is.
              return prev;
            }
            return {
              device: event.device_name,
              generation: generationRef.current ?? "0",
              kind: "active",
            };
          });
          break;

        case "activity-detected":
          // No separate state; consumers observe TestComplete.metadata.
          break;

        case "test-complete":
          setCaptureState({
            kind: "test-complete",
            metadata: event.metadata,
          });
          generationRef.current = null;
          break;

        case "capture-stopped":
          setCaptureState({ kind: "idle" });
          generationRef.current = null;
          break;

        case "capture-cancelled":
          setCaptureState({ kind: "cancelled" });
          generationRef.current = null;
          break;

        case "device-list":
          setDevices(event.devices);
          break;

        case "capture-error":
          setCaptureState({
            category: event.category,
            kind: "error",
            message: event.message,
          });
          generationRef.current = null;
          break;
      }
    });

    queryPermission();
    isCaptureActive().then((active) => {
      if (!mountedRef.current) return;
      if (active) {
        setCaptureState({
          device: "unknown",
          generation: "0",
          kind: "active",
        });
      }
    });
    // Populate device list.
    void listDevices().then((devs) => {
      if (mountedRef.current && devs.length > 0) {
        setDevices(devs);
      }
    });

    return () => {
      mountedRef.current = false;
      subscription.then((unlisten) => unlisten()).catch(() => {});
      stopCapture();
    };
  }, []);

  const requestMicPermission = useCallback(() => {
    setCaptureState({ kind: "requesting-permission" });
    requestPermission();
  }, []);

  const runMicTest = useCallback(async (device?: string) => {
    // Prevent duplicate starts.
    setCaptureState((prev) => {
      if (isCaptureSessionActive(prev)) return prev;
      return {
        generation: "pending",
        kind: "test-running",
        started_at: Date.now(),
      };
    });

    const result = await startMicTest(device);
    if (!mountedRef.current) return;

    if (result === "capture-unavailable") {
      // Browser/non-Tauri environment: capture unavailable.
      setCaptureState({
        category: "capture-unavailable",
        kind: "error",
        message: "Native capture is not available in this environment.",
      });
      return;
    }

    // result is the generation string; store for cancel correlation.
    if (!isNaN(parseInt(result, 10))) {
      generationRef.current = result;
      setCaptureState((prev) => {
        if (prev.kind === "test-running") {
          return { ...prev, generation: result };
        }
        return prev;
      });
    } else {
      // Error category returned from IPC (e.g., "busy").
      const category = result as import("./types").CaptureErrorCategory;
      const messages: Record<string, string> = {
        busy: "A capture session is already active.",
        "capture-unavailable":
          "Microphone capture is not available.",
        "input-limit-exceeded":
          "Capture limit reached.",
        "permission-denied":
          "Microphone permission denied.",
      };
      setCaptureState({
        category,
        kind: "error",
        message: messages[result] ?? result,
      });
    }
  }, []);

  const stopMicTest = useCallback(() => {
    const gen = generationRef.current;
    if (gen) {
      void cancelCapture(gen);
    } else {
      stopCapture();
    }
    setCaptureState({ kind: "idle" });
    generationRef.current = null;
  }, []);

  return {
    captureState,
    devices,
    permissionStatus,
    requestMicPermission,
    runMicTest,
    stopMicTest,
  };
}

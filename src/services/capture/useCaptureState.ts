/// React hook: native capture state — BUS-9.
///
/// Design:
/// - Listener is installed BEFORE any start command is issued so no events
///   are lost between subscribe and start.
/// - Active generation is stored in a ref; stale events (different gen) are
///   discarded on the renderer side.
/// - Duplicate start is blocked via early return before any IPC.
/// - IPC errors (including "busy") are caught and mapped to stable categories.
/// - Unmount cancels any active session and unsubscribes the listener.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

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
  type CaptureErrorCategory,
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
  const generationRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;

    // Install listener BEFORE querying permission or starting any session
    // to avoid dropping events emitted between start and subscribe.
    const subscriptionPromise = onCaptureEvent((event) => {
      if (!mountedRef.current) return;

      // Suppress stale events from a previous session.
      const eventGen =
        "generation" in event ? event.generation : null;
      if (
        eventGen !== null
        && generationRef.current !== null
        && String(eventGen) !== generationRef.current
        && event.kind !== "permission-status"
      ) {
        return; // Stale generation — discard.
      }

      switch (event.kind) {
        case "permission-status":
          setPermissionStatus(event.status);
          if (event.status !== "authorized") {
            setCaptureState((prev) =>
              isCaptureSessionActive(prev) ? { kind: "idle" } : prev,
            );
          }
          break;

        case "capture-started":
          // Preserve test-running mode; update device name side-effect only.
          setCaptureState((prev) =>
            prev.kind === "test-running"
              ? prev
              : {
                  device: event.device_name,
                  generation: generationRef.current ?? "0",
                  kind: "active",
                },
          );
          break;

        case "activity-detected":
          break; // Surfaced via test-complete metadata.

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

    // Query permission and existing active state after subscribing.
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
    listDevices().then((devs) => {
      if (mountedRef.current && devs.length > 0) setDevices(devs);
    });

    return () => {
      mountedRef.current = false;
      // Cancel any active session on unmount (window teardown).
      const gen = generationRef.current;
      if (gen) {
        void cancelCapture(gen);
      } else {
        stopCapture();
      }
      subscriptionPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  const requestMicPermission = useCallback(() => {
    setCaptureState({ kind: "requesting-permission" });
    requestPermission();
  }, []);

  const runMicTest = useCallback(async (device?: string) => {
    // Authoritative duplicate-start guard using ref (not state).
    if (generationRef.current !== null) return;

    // Set test-running immediately before IPC resolves.
    setCaptureState({
      generation: "pending",
      kind: "test-running",
      started_at: Date.now(),
    });

    let result: string;
    try {
      result = await startMicTest(device);
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      setCaptureState({
        category: "capture-unavailable",
        kind: "error",
        message: msg,
      });
      return;
    }

    if (!mountedRef.current) return;

    if (result === "capture-unavailable") {
      setCaptureState({
        category: "capture-unavailable",
        kind: "error",
        message:
          "Native capture is not available in this environment.",
      });
      return;
    }

    const gen = parseInt(result, 10);
    if (!isNaN(gen)) {
      generationRef.current = result;
      setCaptureState((prev) =>
        prev.kind === "test-running"
          ? { ...prev, generation: result }
          : prev,
      );
    } else {
      // IPC returned an error category string (e.g., "busy").
      const category = result as CaptureErrorCategory;
      const messages: Record<CaptureErrorCategory, string> = {
        busy: "A capture session is already active.",
        "capture-unavailable": "Microphone capture is not available.",
        "input-limit-exceeded": "Capture limit reached.",
        "permission-denied": "Microphone permission denied.",
      };
      setCaptureState({
        category,
        kind: "error",
        message: messages[category] ?? result,
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

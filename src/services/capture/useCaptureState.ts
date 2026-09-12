/// React hook: exposes real-time capture state to components.
///
/// Subscribes to native capture events on mount and unsubscribes on unmount.
/// No audio bytes or handles ever enter this hook; only safe metadata.
import { useCallback, useEffect, useRef, useState } from "react";

import {
  isCaptureActive,
  onCaptureEvent,
  queryPermission,
  requestPermission,
  startMicTest,
  stopCapture,
} from "./captureService";
import type { CaptureState, PermissionStatus } from "./types";

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

  // Guard: stale events from a previous mount should not update state.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const subscription = onCaptureEvent((event) => {
      if (!mountedRef.current) return;

      switch (event.kind) {
        case "permission-status":
          setPermissionStatus(event.status);
          if (event.status !== "authorized") {
            setCaptureState({ kind: "idle" });
          }
          break;
        case "capture-started":
          setCaptureState({
            device: event.device_name,
            kind: "active",
          });
          break;
        case "activity-detected":
          // Surfaced via captureState.kind; no separate state needed.
          break;
        case "test-complete":
          setCaptureState({
            kind: "test-complete",
            metadata: event.metadata,
          });
          break;
        case "capture-stopped":
          setCaptureState({ kind: "idle" });
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
          break;
      }
    });

    // Query permission and active state on mount.
    queryPermission();
    isCaptureActive().then((active) => {
      if (!mountedRef.current) return;
      if (active) {
        setCaptureState({ device: "unknown", kind: "active" });
      }
    });

    return () => {
      mountedRef.current = false;
      // Cancel subscription asynchronously; ignore errors on unmount.
      subscription.then((unlisten) => unlisten()).catch(() => {});
      // Stop any active session on unmount (window teardown safety).
      stopCapture();
    };
  }, []);

  const requestMicPermission = useCallback(() => {
    setCaptureState({ kind: "requesting-permission" });
    requestPermission();
  }, []);

  const runMicTest = useCallback(async (device?: string) => {
    setCaptureState({
      kind: "test-running",
      started_at: Date.now(),
    });
    const result = await startMicTest(device);
    if (!mountedRef.current) return;
    if (result !== "ok") {
      setCaptureState({
        category: "capture-unavailable",
        kind: "error",
        message: result,
      });
    }
    // Terminal state arrives via event; no state update here.
  }, []);

  const stopMicTest = useCallback(() => {
    stopCapture();
    setCaptureState({ kind: "idle" });
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

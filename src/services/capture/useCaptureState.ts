import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  cancelCapture,
  createCaptureRequestId,
  getCaptureStatus,
  isTauriEnv,
  listDevices,
  onCaptureEvent,
  queryPermission,
  requestPermission,
  startMicTest,
} from "./captureService";
import type {
  CaptureErrorCategory,
  CaptureEvent,
  CaptureMode,
  CaptureState,
  CaptureStatus,
  PermissionStatus,
} from "./types";

interface CaptureOwner {
  generation: number | null;
  mode: CaptureMode;
  requestId: string;
}

type ListenerResult =
  | { ok: true; unlisten: () => void }
  | { error: string; ok: false };

export interface UseCaptureStateResult {
  captureState: CaptureState;
  devices: string[];
  permissionStatus: PermissionStatus | null;
  requestMicPermission: () => void;
  runMicTest: (device?: string) => Promise<void>;
  stopMicTest: () => void;
}

const errorMessages: Record<CaptureErrorCategory, string> = {
  busy: "A capture session is already active.",
  "capture-unavailable": "Microphone capture is not available.",
  "input-limit-exceeded": "Capture limit reached.",
  "permission-denied": "Microphone permission denied.",
};

function normalizeError(error: unknown): {
  category: CaptureErrorCategory;
  message: string;
} {
  const detail = error instanceof Error ? error.message : String(error);
  const category = (Object.keys(errorMessages) as CaptureErrorCategory[])
    .find((candidate) => detail.includes(candidate))
    ?? "capture-unavailable";
  return {
    category,
    message: errorMessages[category],
  };
}

function stateFromStatus(status: CaptureStatus): CaptureState {
  if (status.mode === "test") {
    return {
      generation: status.generation,
      kind: "test-running",
      request_id: status.request_id,
      started_at: Date.now(),
    };
  }
  return {
    device: "Active microphone",
    generation: status.generation,
    kind: "active",
    request_id: status.request_id,
  };
}

export function useCaptureState(): UseCaptureStateResult {
  const [captureState, setCaptureState] =
    useState<CaptureState>({ kind: "idle" });
  const [devices, setDevices] = useState<string[]>([]);
  const [permissionStatus, setPermissionStatus] =
    useState<PermissionStatus | null>(null);
  const listenerRef = useRef<Promise<ListenerResult> | null>(null);
  const mountedRef = useRef(false);
  const ownerRef = useRef<CaptureOwner | null>(null);

  useEffect(() => {
    let disposed = false;
    mountedRef.current = true;

    const handleEvent = (event: CaptureEvent) => {
      if (disposed || !mountedRef.current) return;
      if (event.kind === "device-list") {
        setDevices(event.devices);
        return;
      }
      if (event.kind === "permission-status") {
        setPermissionStatus(event.status);
        return;
      }

      const owner = ownerRef.current;
      if (!owner || event.request_id !== owner.requestId) return;
      if (owner.generation !== null
          && event.generation !== owner.generation) return;

      if (event.kind === "capture-started") {
        owner.generation = event.generation;
        if (owner.mode === "test") {
          setCaptureState((previous) => previous.kind === "test-running"
            ? { ...previous, generation: event.generation }
            : previous);
        } else {
          setCaptureState({
            device: event.device_name,
            generation: event.generation,
            kind: "active",
            request_id: event.request_id,
          });
        }
        return;
      }
      if (event.kind === "activity-detected") return;

      ownerRef.current = null;
      if (event.kind === "test-complete") {
        setCaptureState({
          kind: "test-complete",
          metadata: event.metadata,
        });
      } else if (event.kind === "capture-cancelled") {
        setCaptureState({ kind: "cancelled" });
      } else if (event.kind === "capture-error") {
        setCaptureState({
          category: event.category,
          kind: "error",
          message: event.message,
        });
      } else {
        setCaptureState({ kind: "idle" });
      }
    };

    const listener = onCaptureEvent(handleEvent)
      .then((unlisten): ListenerResult => ({ ok: true, unlisten }))
      .catch((error: unknown): ListenerResult => {
        const normalized = normalizeError(error);
        if (!disposed && mountedRef.current) {
          setCaptureState({ kind: "error", ...normalized });
        }
        return { error: normalized.message, ok: false };
      });
    listenerRef.current = listener;

    void listener.then(async (result) => {
      if (!result.ok || disposed || !mountedRef.current) return;
      const permissionRequestId = createCaptureRequestId();
      const operations = await Promise.allSettled([
        getCaptureStatus(),
        listDevices(),
        queryPermission(permissionRequestId),
      ]);
      if (disposed || !mountedRef.current) return;

      const [statusResult, devicesResult] = operations;
      if (statusResult.status === "fulfilled"
          && statusResult.value
          && ownerRef.current === null) {
        const status = statusResult.value;
        ownerRef.current = {
          generation: status.generation,
          mode: status.mode,
          requestId: status.request_id,
        };
        setCaptureState(stateFromStatus(status));
      } else if (statusResult.status === "rejected"
          && ownerRef.current === null) {
        setCaptureState({
          kind: "error",
          ...normalizeError(statusResult.reason),
        });
      }
      if (devicesResult.status === "fulfilled") {
        setDevices(devicesResult.value);
      }
    });

    return () => {
      disposed = true;
      mountedRef.current = false;
      listenerRef.current = null;
      const owner = ownerRef.current;
      ownerRef.current = null;
      if (owner) {
        void cancelCapture(owner.requestId).catch(() => {});
      }
      void listener.then((result) => {
        if (result.ok) result.unlisten();
      });
    };
  }, []);

  const requestMicPermission = useCallback(() => {
    if (!isTauriEnv()) {
      setCaptureState({
        category: "capture-unavailable",
        kind: "error",
        message: errorMessages["capture-unavailable"],
      });
      return;
    }
    setCaptureState({ kind: "requesting-permission" });
    const requestId = createCaptureRequestId();
    void (async () => {
      const listener = await listenerRef.current;
      if (!listener?.ok || !mountedRef.current) return;
      try {
        await requestPermission(requestId);
      } catch (error: unknown) {
        if (mountedRef.current) {
          setCaptureState({ kind: "error", ...normalizeError(error) });
        }
      }
    })();
  }, []);

  const runMicTest = useCallback(async (device?: string) => {
    if (ownerRef.current !== null) return;

    const requestId = createCaptureRequestId();
    ownerRef.current = {
      generation: null,
      mode: "test",
      requestId,
    };
    setCaptureState({
      generation: null,
      kind: "test-running",
      request_id: requestId,
      started_at: Date.now(),
    });

    const listener = await listenerRef.current;
    if (!listener?.ok || !mountedRef.current) {
      if (ownerRef.current?.requestId === requestId) {
        ownerRef.current = null;
      }
      if (mountedRef.current) {
        setCaptureState({
          category: "capture-unavailable",
          kind: "error",
          message: listener?.ok === false
            ? listener.error
            : errorMessages["capture-unavailable"],
        });
      }
      return;
    }

    try {
      const status = await startMicTest(requestId, device);
      if (!mountedRef.current
          || ownerRef.current?.requestId !== requestId) return;
      if (status.request_id !== requestId) {
        ownerRef.current = null;
        setCaptureState({
          category: "capture-unavailable",
          kind: "error",
          message: errorMessages["capture-unavailable"],
        });
        return;
      }
      ownerRef.current.generation = status.generation;
      setCaptureState((previous) => previous.kind === "test-running"
        && previous.request_id === requestId
        ? { ...previous, generation: status.generation }
        : previous);
    } catch (error: unknown) {
      if (!mountedRef.current
          || ownerRef.current?.requestId !== requestId) return;
      ownerRef.current = null;
      setCaptureState({ kind: "error", ...normalizeError(error) });
    }
  }, []);

  const stopMicTest = useCallback(() => {
    const owner = ownerRef.current;
    ownerRef.current = null;
    if (owner) {
      void cancelCapture(owner.requestId).catch(() => {});
    }
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

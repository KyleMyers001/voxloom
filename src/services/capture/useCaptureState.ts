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
  InputDeviceDescriptor,
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
  captureReady: boolean;
  captureState: CaptureState;
  deviceListError: string | null;
  devices: InputDeviceDescriptor[];
  devicesLoading: boolean;
  permissionStatus: PermissionStatus | null;
  prepareDeviceChange: () => Promise<boolean>;
  refreshDevices: () => Promise<void>;
  requestMicPermission: () => void;
  runMicTest: (deviceId?: string) => Promise<void>;
  stopMicTest: () => void;
}

interface TerminalWaiter {
  cancelSent: boolean;
  promise: Promise<boolean>;
  requestId: string;
  resolve: (completed: boolean) => void;
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
  const [captureReady, setCaptureReady] = useState(false);
  const [captureState, setCaptureState] =
    useState<CaptureState>({ kind: "idle" });
  const [deviceListError, setDeviceListError] =
    useState<string | null>(null);
  const [devices, setDevices] = useState<InputDeviceDescriptor[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [permissionStatus, setPermissionStatus] =
    useState<PermissionStatus | null>(null);
  const listenerRef = useRef<Promise<ListenerResult> | null>(null);
  const mountedRef = useRef(false);
  const ownerRef = useRef<CaptureOwner | null>(null);
  const refreshSequenceRef = useRef(0);
  const switchSequenceRef = useRef(0);
  const terminalWaiterRef = useRef<TerminalWaiter | null>(null);

  const refreshDevices = useCallback(async () => {
    const sequence = ++refreshSequenceRef.current;
    setDevicesLoading(true);
    try {
      const listed = await listDevices();
      if (!mountedRef.current
          || sequence !== refreshSequenceRef.current) return;
      setDevices(listed);
      setDeviceListError(null);
    } catch (error: unknown) {
      if (!mountedRef.current
          || sequence !== refreshSequenceRef.current) return;
      setDeviceListError(normalizeError(error).message);
    } finally {
      if (mountedRef.current
          && sequence === refreshSequenceRef.current) {
        setDevicesLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    mountedRef.current = true;

    const handleEvent = (event: CaptureEvent) => {
      if (disposed || !mountedRef.current) return;
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
      const waiter = terminalWaiterRef.current;
      if (waiter?.requestId === event.request_id) {
        terminalWaiterRef.current = null;
        waiter.resolve(true);
      }
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
      void refreshDevices();
      const operations = await Promise.allSettled([
        getCaptureStatus(),
        queryPermission(permissionRequestId),
      ]);
      if (disposed || !mountedRef.current) return;

      const [statusResult] = operations;
      if (statusResult.status === "fulfilled") {
        if (statusResult.value && ownerRef.current === null) {
          const status = statusResult.value;
          ownerRef.current = {
            generation: status.generation,
            mode: status.mode,
            requestId: status.request_id,
          };
          setCaptureState(stateFromStatus(status));
        }
        setCaptureReady(true);
      } else if (statusResult.status === "rejected"
          && ownerRef.current === null) {
        setCaptureState({
          kind: "error",
          ...normalizeError(statusResult.reason),
        });
      }
    });

    return () => {
      disposed = true;
      mountedRef.current = false;
      listenerRef.current = null;
      refreshSequenceRef.current += 1;
      switchSequenceRef.current += 1;
      const terminalWaiter = terminalWaiterRef.current;
      terminalWaiter?.resolve(false);
      terminalWaiterRef.current = null;
      const owner = ownerRef.current;
      ownerRef.current = null;
      const cancellationAlreadySent = owner
        && terminalWaiter?.requestId === owner.requestId
        && terminalWaiter.cancelSent;
      if (owner && !cancellationAlreadySent) {
        void cancelCapture(owner.requestId).catch(() => {});
      }
      void listener.then((result) => {
        if (result.ok) result.unlisten();
      });
    };
  }, [refreshDevices]);

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

  const runMicTest = useCallback(async (deviceId?: string) => {
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
      const status = await startMicTest(requestId, deviceId);
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

  const prepareDeviceChange = useCallback(async () => {
    if (!captureReady) return false;
    const sequence = ++switchSequenceRef.current;
    const owner = ownerRef.current;
    if (!owner) return true;

    setCaptureState({ kind: "switching-device" });
    let waiter = terminalWaiterRef.current;
    if (!waiter || waiter.requestId !== owner.requestId) {
      let resolve: (completed: boolean) => void = () => {
        throw new Error("terminal waiter was not initialized");
      };
      const promise = new Promise<boolean>((complete) => {
        resolve = complete;
      });
      waiter = {
        cancelSent: false,
        promise,
        requestId: owner.requestId,
        resolve,
      };
      terminalWaiterRef.current = waiter;
    }

    if (!waiter.cancelSent) {
      waiter.cancelSent = true;
      try {
        await cancelCapture(owner.requestId);
      } catch (error: unknown) {
        if (mountedRef.current
            && sequence === switchSequenceRef.current) {
          setCaptureState({ kind: "error", ...normalizeError(error) });
        }
        return false;
      }
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolveTimeout) => {
      timeoutId = setTimeout(() => resolveTimeout(false), 5_000);
    });
    const completed = await Promise.race([waiter.promise, timedOut]);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (!mountedRef.current
        || sequence !== switchSequenceRef.current) return false;
    if (!completed) {
      setCaptureState({
        category: "capture-unavailable",
        kind: "error",
        message: "Microphone did not stop; selection was not changed.",
      });
      return false;
    }
    setCaptureState({ kind: "idle" });
    return true;
  }, [captureReady]);

  const stopMicTest = useCallback(() => {
    const owner = ownerRef.current;
    if (owner) {
      void cancelCapture(owner.requestId).catch(() => {});
    }
    setCaptureState({ kind: "idle" });
  }, []);

  return {
    captureReady,
    captureState,
    deviceListError,
    devices,
    devicesLoading,
    permissionStatus,
    prepareDeviceChange,
    refreshDevices,
    requestMicPermission,
    runMicTest,
    stopMicTest,
  };
}

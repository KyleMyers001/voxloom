import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  cancelCapture,
  createCaptureRequestId,
  getCaptureStatus,
  isTauriEnv,
  listDevices,
  onCaptureEvent,
  queryPermission,
  requestPermission,
  startFullCapture,
  startMicTest,
  stopCapture,
} from './captureService';
import type {
  CaptureErrorCategory,
  CaptureEvent,
  CaptureMode,
  CaptureState,
  CaptureStatus,
  InputDeviceDescriptor,
  PermissionStatus,
} from './types';

interface CaptureOwner {
  generation: number | null;
  mode: CaptureMode;
  requestId: string;
  /** Caller token echoed on this capture's stopped state. */
  tag?: unknown;
}

export type StoppedCapture = Extract<CaptureState, { kind: 'stopped' }>;

type ListenerResult =
  | { ok: true; unlisten: () => void }
  | { error: string; ok: false };

export interface UseCaptureStateResult {
  /**
   * Discard in-flight capture (no PCM deposit / no STT). With `isOwn`, a
   * capture whose owner token it rejects (an older session's) is left alone.
   */
  cancelActiveCapture: (isOwn?: (owner: unknown) => boolean) => void;
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
  /**
   * Called synchronously when a full capture stops, before any restart
   * waiting on its release continues, so no stop is lost to batching.
   * Returns an unsubscribe function.
   */
  onCaptureStopped?: (listener: (stopped: StoppedCapture) => void) => () => void;
  /**
   * Start full-mode capture; never treat a silent busy return as success.
   * `owner` is echoed on this capture's stopped state.
   */
  startFullCaptureSession: (deviceId?: string, owner?: unknown) => Promise<
    'started' | 'ended' | 'busy' | 'error'
  >;
  /**
   * Clean-stop full capture: deposits PCM and emits `capture-stopped.audio`.
   * Prefer over cancel when the utterance should reach STT.
   */
  stopFullCapture: (isOwn?: (owner: unknown) => boolean) => Promise<void>;
  stopMicTest: () => void;
  /**
   * Resolve once a cancelled or stopping capture's terminal event releases
   * ownership (bounded), so a fast restart is not refused as busy.
   * Resolves at once when no cancelled or stopping owner is pending. On
   * timeout it cancels that capture, drops its ownership and resolves false.
   */
  waitForCaptureRelease: () => Promise<boolean>;
}

/** Bound on waiting for a cancelled capture's terminal event. */
const RELEASE_TIMEOUT_MS = 5_000;

function createTerminalWaiter(requestId: string): TerminalWaiter {
  let resolve: (completed: boolean) => void = () => {
    throw new Error('terminal waiter was not initialized');
  };
  const promise = new Promise<boolean>((complete) => {
    resolve = complete;
  });
  return { cancelSent: false, promise, requestId, resolve };
}

async function raceTimeout(promise: Promise<boolean>, ms: number) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolveTimeout) => {
    timeoutId = setTimeout(() => resolveTimeout(false), ms);
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    clearTimeout(timeoutId);
  }
}

interface TerminalWaiter {
  cancelSent: boolean;
  promise: Promise<boolean>;
  requestId: string;
  resolve: (completed: boolean) => void;
}

interface TerminalCorrelation {
  generation: number;
  requestId: string;
}

const MAX_TERMINAL_CORRELATIONS = 32;

const errorMessages: Record<CaptureErrorCategory, string> = {
  busy: 'A capture session is already active.',
  'capture-unavailable': 'Microphone capture is not available.',
  'input-limit-exceeded': 'Capture limit reached.',
  'permission-denied': 'Microphone permission denied.',
};

function normalizeError(error: unknown): {
  category: CaptureErrorCategory;
  message: string;
} {
  const detail = error instanceof Error ? error.message : String(error);
  const category = (Object.keys(errorMessages) as CaptureErrorCategory[])
    .find((candidate) => detail.includes(candidate))
    ?? 'capture-unavailable';
  return {
    category,
    message: errorMessages[category],
  };
}

function stateFromStatus(status: CaptureStatus): CaptureState {
  if (status.mode === 'test') {
    return {
      generation: status.generation,
      kind: 'test-running',
      request_id: status.request_id,
      started_at: Date.now(),
    };
  }
  return {
    device: 'Active microphone',
    generation: status.generation,
    kind: 'active',
    request_id: status.request_id,
  };
}

function isTerminalEvent(event: CaptureEvent): boolean {
  return event.kind === 'capture-cancelled'
    || event.kind === 'capture-error'
    || event.kind === 'capture-stopped'
    || event.kind === 'test-complete';
}

function rememberTerminal(
  terminals: TerminalCorrelation[],
  event: CaptureEvent,
): boolean {
  if (!isTerminalEvent(event)) return false;
  terminals.push({
    generation: event.generation,
    requestId: event.request_id,
  });
  if (terminals.length > MAX_TERMINAL_CORRELATIONS) {
    terminals.shift();
    return true;
  }
  return false;
}

function consumeTerminal(
  terminals: TerminalCorrelation[],
  status: CaptureStatus,
): boolean {
  const index = terminals.findIndex((terminal) =>
    terminal.generation === status.generation
      && terminal.requestId === status.request_id);
  if (index < 0) return false;
  terminals.splice(index, 1);
  return true;
}

export function useCaptureState(): UseCaptureStateResult {
  const [captureReady, setCaptureReady] = useState(false);
  const [captureState, setCaptureState] =
    useState<CaptureState>({ kind: 'idle' });
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
  const terminalCacheOverflowRef = useRef(false);
  const terminalWaiterRef = useRef<TerminalWaiter | null>(null);
  const stopListenersRef = useRef(new Set<(stopped: StoppedCapture) => void>());
  const terminalsRef = useRef<TerminalCorrelation[]>([]);
  const statusPendingRef = useRef(false);

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
      if (event.kind === 'permission-status') {
        setPermissionStatus(event.status);
        return;
      }

      if (statusPendingRef.current
          && rememberTerminal(terminalsRef.current, event)) {
        terminalCacheOverflowRef.current = true;
      }

      const owner = ownerRef.current;
      if (!owner || event.request_id !== owner.requestId) return;
      if (owner.generation !== null
          && event.generation !== owner.generation) return;

      if (event.kind === 'capture-started') {
        owner.generation = event.generation;
        if (owner.mode === 'test') {
          setCaptureState((previous) => previous.kind === 'test-running'
            ? { ...previous, generation: event.generation }
            : previous);
        } else {
          setCaptureState({
            device: event.device_name,
            generation: event.generation,
            kind: 'active',
            request_id: event.request_id,
          });
        }
        return;
      }
      if (event.kind === 'activity-detected' || event.kind === 'capture-level') return;

      ownerRef.current = null;
      const waiter = terminalWaiterRef.current;
      if (waiter?.requestId === event.request_id) {
        terminalWaiterRef.current = null;
        waiter.resolve(true);
      }
      if (event.kind === 'test-complete') {
        setCaptureState({
          kind: 'test-complete',
          metadata: event.metadata,
        });
      } else if (event.kind === 'capture-cancelled') {
        setCaptureState({ kind: 'cancelled' });
      } else if (event.kind === 'capture-error') {
        setCaptureState({
          category: event.category,
          kind: 'error',
          message: event.message,
        });
      } else if (event.kind === 'capture-stopped') {
        const stopped: StoppedCapture = { audio: event.audio, kind: 'stopped', owner: owner.tag };
        // Synchronous: the released waiter's restart continues only later.
        for (const listener of [...stopListenersRef.current]) listener(stopped);
        setCaptureState(stopped);
      } else {
        setCaptureState({ kind: 'idle' });
      }
    };

    const listener = onCaptureEvent(handleEvent)
      .then((unlisten): ListenerResult => ({ ok: true, unlisten }))
      .catch((error: unknown): ListenerResult => {
        const normalized = normalizeError(error);
        if (!disposed && mountedRef.current) {
          setCaptureState({ kind: 'error', ...normalized });
        }
        return { error: normalized.message, ok: false };
      });
    listenerRef.current = listener;

    void listener.then(async (result) => {
      if (!result.ok || disposed || !mountedRef.current) return;
      const permissionRequestId = createCaptureRequestId();
      statusPendingRef.current = true;
      void refreshDevices();
      const operations = await Promise.allSettled([
        getCaptureStatus(),
        queryPermission(permissionRequestId),
      ]);
      if (disposed || !mountedRef.current) return;

      const [statusResult] = operations;
      if (statusResult.status === 'fulfilled') {
        if (terminalCacheOverflowRef.current) {
          setCaptureState({
            category: 'capture-unavailable',
            kind: 'error',
            message: errorMessages['capture-unavailable'],
          });
        } else if (statusResult.value && ownerRef.current === null) {
          const status = statusResult.value;
          if (!consumeTerminal(terminalsRef.current, status)) {
            ownerRef.current = {
              generation: status.generation,
              mode: status.mode,
              requestId: status.request_id,
            };
            setCaptureState(stateFromStatus(status));
          }
        }
        setCaptureReady(!terminalCacheOverflowRef.current);
      } else if (statusResult.status === 'rejected'
          && ownerRef.current === null) {
        setCaptureState({
          kind: 'error',
          ...normalizeError(statusResult.reason),
        });
      }
      statusPendingRef.current = false;
      terminalCacheOverflowRef.current = false;
      terminalsRef.current = [];
    });

    return () => {
      disposed = true;
      mountedRef.current = false;
      listenerRef.current = null;
      statusPendingRef.current = false;
      terminalCacheOverflowRef.current = false;
      terminalsRef.current = [];
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
        category: 'capture-unavailable',
        kind: 'error',
        message: errorMessages['capture-unavailable'],
      });
      return;
    }
    setCaptureState({ kind: 'requesting-permission' });
    const requestId = createCaptureRequestId();
    void (async () => {
      const listener = await listenerRef.current;
      if (!listener?.ok || !mountedRef.current) return;
      try {
        await requestPermission(requestId);
      } catch (error: unknown) {
        if (mountedRef.current) {
          setCaptureState({ kind: 'error', ...normalizeError(error) });
        }
      }
    })();
  }, []);

  const runMicTest = useCallback(async (deviceId?: string) => {
    if (ownerRef.current !== null) return;

    const requestId = createCaptureRequestId();
    ownerRef.current = {
      generation: null,
      mode: 'test',
      requestId,
    };
    setCaptureState({
      generation: null,
      kind: 'test-running',
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
          category: 'capture-unavailable',
          kind: 'error',
          message: listener?.ok === false
            ? listener.error
            : errorMessages['capture-unavailable'],
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
          category: 'capture-unavailable',
          kind: 'error',
          message: errorMessages['capture-unavailable'],
        });
        return;
      }
      ownerRef.current.generation = status.generation;
      setCaptureState((previous) => previous.kind === 'test-running'
        && previous.request_id === requestId
        ? { ...previous, generation: status.generation }
        : previous);
    } catch (error: unknown) {
      if (!mountedRef.current
          || ownerRef.current?.requestId !== requestId) return;
      ownerRef.current = null;
      setCaptureState({ kind: 'error', ...normalizeError(error) });
    }
  }, []);

  const prepareDeviceChange = useCallback(async () => {
    if (!captureReady) return false;
    const sequence = ++switchSequenceRef.current;
    const owner = ownerRef.current;
    if (!owner) return true;

    setCaptureState({ kind: 'switching-device' });
    let waiter = terminalWaiterRef.current;
    if (!waiter || waiter.requestId !== owner.requestId) {
      waiter = createTerminalWaiter(owner.requestId);
      terminalWaiterRef.current = waiter;
    }

    if (!waiter.cancelSent) {
      waiter.cancelSent = true;
      try {
        await cancelCapture(owner.requestId);
      } catch (error: unknown) {
        if (mountedRef.current
            && sequence === switchSequenceRef.current) {
          setCaptureState({ kind: 'error', ...normalizeError(error) });
        }
        return false;
      }
    }

    const completed = await raceTimeout(waiter.promise, RELEASE_TIMEOUT_MS);
    if (!mountedRef.current
        || sequence !== switchSequenceRef.current) return false;
    if (!completed) {
      setCaptureState({
        category: 'capture-unavailable',
        kind: 'error',
        message: 'Microphone did not stop; selection was not changed.',
      });
      return false;
    }
    setCaptureState({ kind: 'idle' });
    return true;
  }, [captureReady]);

  const startFullCaptureSession = useCallback(async (deviceId?: string, owner?: unknown) => {
    if (ownerRef.current !== null) return 'busy' as const;

    const requestId = createCaptureRequestId();
    ownerRef.current = {
      generation: null,
      mode: 'full',
      requestId,
      tag: owner,
    };
    setCaptureState({
      device: 'Starting…',
      generation: 0,
      kind: 'active',
      request_id: requestId,
    });

    const listener = await listenerRef.current;
    if (!listener?.ok || !mountedRef.current) {
      if (ownerRef.current?.requestId === requestId) {
        ownerRef.current = null;
      }
      if (mountedRef.current) {
        setCaptureState({
          category: 'capture-unavailable',
          kind: 'error',
          message: listener?.ok === false
            ? listener.error
            : errorMessages['capture-unavailable'],
        });
      }
      return 'error' as const;
    }

    try {
      const status = await startFullCapture(requestId, deviceId);
      // A terminal event can arrive before the start command resolves.
      // Never resurrect its old owner or report a fresh recording.
      if (!mountedRef.current
          || ownerRef.current?.requestId !== requestId) return 'ended' as const;
      if (status.request_id !== requestId) {
        ownerRef.current = null;
        setCaptureState({
          category: 'capture-unavailable',
          kind: 'error',
          message: errorMessages['capture-unavailable'],
        });
        return 'error' as const;
      }
      ownerRef.current.generation = status.generation;
      setCaptureState((previous) => previous.kind === 'active'
        && previous.request_id === requestId
        ? { ...previous, generation: status.generation }
        : previous);
      return 'started' as const;
    } catch (error: unknown) {
      if (!mountedRef.current
          || ownerRef.current?.requestId !== requestId) return 'ended' as const;
      ownerRef.current = null;
      setCaptureState({ kind: 'error', ...normalizeError(error) });
      return 'error' as const;
    }
  }, []);

  /** Track `requestId`'s terminal event so a restart can wait for release. */
  const trackRelease = useCallback((requestId: string) => {
    let waiter = terminalWaiterRef.current;
    if (waiter?.requestId !== requestId) {
      waiter = createTerminalWaiter(requestId);
      terminalWaiterRef.current = waiter;
    }
    waiter.cancelSent = true;
  }, []);

  const stopFullCapture = useCallback(async (isOwn?: (owner: unknown) => boolean) => {
    const owner = ownerRef.current;
    if (!owner || owner.mode !== 'full' || isOwn?.(owner.tag) === false) return;
    // A stop releases the mic too: a quick re-hold waits for its stop.
    trackRelease(owner.requestId);
    try {
      await stopCapture();
    } catch (error: unknown) {
      if (mountedRef.current) {
        setCaptureState({ kind: 'error', ...normalizeError(error) });
      }
    }
  }, [trackRelease]);

  const cancelActiveCapture = useCallback((isOwn?: (owner: unknown) => boolean) => {
    const owner = ownerRef.current;
    if (owner && isOwn?.(owner.tag) === false) return;
    if (owner) {
      trackRelease(owner.requestId);
      void cancelCapture(owner.requestId).catch(() => {});
    }
    // Optimistic UX; terminal event still updates to cancelled/idle.
    setCaptureState({ kind: 'cancelled' });
  }, [trackRelease]);

  const onCaptureStopped = useCallback((listener: (stopped: StoppedCapture) => void) => {
    stopListenersRef.current.add(listener);
    return () => { stopListenersRef.current.delete(listener); };
  }, []);

  const waitForCaptureRelease = useCallback(async () => {
    const owner = ownerRef.current;
    const waiter = terminalWaiterRef.current;
    if (!owner || waiter?.requestId !== owner.requestId
        || !waiter.cancelSent) return true;
    if (await raceTimeout(waiter.promise, RELEASE_TIMEOUT_MS)) return true;
    if (!mountedRef.current || ownerRef.current !== owner) return true;
    // The terminal never came: cancel that capture and drop its ownership,
    // so this and every later start is not refused as busy.
    void cancelCapture(owner.requestId).catch(() => {});
    ownerRef.current = null;
    if (terminalWaiterRef.current === waiter) terminalWaiterRef.current = null;
    setCaptureState({ kind: 'idle' }); // no capture is live any more
    return false;
  }, []);

  const stopMicTest = useCallback(() => {
    const owner = ownerRef.current;
    if (owner) {
      void cancelCapture(owner.requestId).catch(() => {});
    }
    setCaptureState({ kind: 'idle' });
  }, []);

  return {
    cancelActiveCapture,
    captureReady,
    captureState,
    deviceListError,
    devices,
    devicesLoading,
    onCaptureStopped,
    permissionStatus,
    prepareDeviceChange,
    refreshDevices,
    requestMicPermission,
    runMicTest,
    startFullCaptureSession,
    stopFullCapture,
    stopMicTest,
    waitForCaptureRelease,
  };
}

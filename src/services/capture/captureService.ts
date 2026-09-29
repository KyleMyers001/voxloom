import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type {
  CaptureEvent,
  CaptureStatus,
  InputDeviceDescriptor,
} from './types';

const CAPTURE_EVENT = 'capture:event';
let nextRequestId = 1;

export { isTauri as isTauriEnv };

export function createCaptureRequestId(): string {
  const sequence = nextRequestId++;
  return `capture-${Date.now()}-${sequence}`;
}

export async function onCaptureEvent(
  handler: (event: CaptureEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<CaptureEvent>(CAPTURE_EVENT, (event) => {
    handler(event.payload);
  });
}

export async function queryPermission(requestId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('capture_query_permission', { requestId });
}

export async function requestPermission(requestId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('capture_request_permission', { requestId });
}

export async function startMicTest(
  requestId: string,
  preferredDeviceId?: string,
): Promise<CaptureStatus> {
  if (!isTauri()) {
    throw new Error('capture-unavailable');
  }
  return invoke<CaptureStatus>('capture_start', {
    preferredDeviceId: preferredDeviceId ?? null,
    requestId,
    testMode: true,
  });
}


export async function startFullCapture(
  requestId: string,
  preferredDeviceId?: string,
): Promise<CaptureStatus> {
  if (!isTauri()) {
    throw new Error('capture-unavailable');
  }
  return invoke<CaptureStatus>('capture_start', {
    preferredDeviceId: preferredDeviceId ?? null,
    requestId,
    testMode: false,
  });
}

/** Discard in-flight capture (no PCM deposit). */
export async function cancelCapture(requestId: string): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>('capture_cancel', { requestId });
}

/**
 * Clean-stop active capture: deposits PCM and emits `capture-stopped.audio`
 * for STT. Prefer this over `cancelCapture` when ending an utterance.
 */
export async function stopCapture(): Promise<void> {
  if (!isTauri()) return;
  await invoke('capture_stop');
}

export async function getCaptureStatus(): Promise<CaptureStatus | null> {
  if (!isTauri()) return null;
  return invoke<CaptureStatus | null>('capture_status');
}

export async function listDevices(): Promise<InputDeviceDescriptor[]> {
  if (!isTauri()) return [];
  return invoke<InputDeviceDescriptor[]>('capture_list_devices');
}

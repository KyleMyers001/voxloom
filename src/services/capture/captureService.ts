/// Capture service — BUS-9.
///
/// Uses `isTauri()` from @tauri-apps/api/core (checks the real runtime
/// marker set by Tauri, not `window.__TAURI__`). Every IPC call is guarded;
/// non-Tauri environments receive safe fallbacks with no unhandled errors.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { CaptureEvent } from "./types";

const CAPTURE_EVENT = "capture:event";

/// Re-export so components can guard Tauri-only UI.
export { isTauri as isTauriEnv };

/// Subscribe to capture events. Returns no-op unlisten outside Tauri.
export async function onCaptureEvent(
  handler: (event: CaptureEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<CaptureEvent>(CAPTURE_EVENT, (e) => handler(e.payload));
}

/// Query current microphone permission without prompting.
export function queryPermission(): void {
  if (!isTauri()) return;
  void invoke("capture_query_permission");
}

/// Request microphone permission (prompts when not-determined).
export function requestPermission(): void {
  if (!isTauri()) return;
  void invoke("capture_request_permission");
}

/// Start a 10-second mic test.
/// Returns the session generation string, or an error category string.
export async function startMicTest(
  preferredDevice?: string,
): Promise<string> {
  if (!isTauri()) return "capture-unavailable";
  return invoke<string>("capture_start", {
    preferredDevice: preferredDevice ?? null,
    testMode: true,
  });
}

/// Cancel a session by generation. Returns false outside Tauri.
export async function cancelCapture(
  generation: string,
): Promise<boolean> {
  const gen = parseInt(generation, 10);
  if (!isTauri() || isNaN(gen)) return false;
  return invoke<boolean>("capture_cancel", { generation: gen });
}

/// Stop any active capture session. Idempotent.
export function stopCapture(): void {
  if (!isTauri()) return;
  void invoke("capture_stop");
}

/// True when a capture session is currently active.
export async function isCaptureActive(): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("capture_is_active");
}

/// Enumerate input device names. Returns [] outside Tauri.
export async function listDevices(): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>("capture_list_devices");
}

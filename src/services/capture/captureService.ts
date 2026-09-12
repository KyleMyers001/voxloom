/// Capture service — BUS-9.
///
/// Wraps Tauri IPC commands for the native capture coordinator.
/// Guards all calls: when running in a browser (no Tauri runtime), returns
/// safe fallbacks. No unhandled errors; no live mic in non-Tauri context.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { CaptureEvent } from "./types";

const CAPTURE_EVENT = "capture:event";

/// True when running inside a real Tauri app window.
export function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

/// Subscribe to capture events. Returns no-op unlisten outside Tauri.
export async function onCaptureEvent(
  handler: (event: CaptureEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauriEnv()) return () => {};
  return listen<CaptureEvent>(CAPTURE_EVENT, (e) => handler(e.payload));
}

/// Query current microphone permission without prompting.
export function queryPermission(): void {
  if (!isTauriEnv()) return;
  void invoke("capture_query_permission");
}

/// Request microphone permission (prompts when not-determined).
export function requestPermission(): void {
  if (!isTauriEnv()) return;
  void invoke("capture_request_permission");
}

/// Start a 10-second mic test.
/// Returns the session generation string on success, or an error category.
export async function startMicTest(
  preferredDevice?: string,
): Promise<string> {
  if (!isTauriEnv()) return "capture-unavailable";
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
  if (!isTauriEnv() || isNaN(gen)) return false;
  return invoke<boolean>("capture_cancel", { generation: gen });
}

/// Stop any active capture session. Idempotent.
export function stopCapture(): void {
  if (!isTauriEnv()) return;
  void invoke("capture_stop");
}

/// True when a capture session is currently active.
export async function isCaptureActive(): Promise<boolean> {
  if (!isTauriEnv()) return false;
  return invoke<boolean>("capture_is_active");
}

/// Enumerate input device names. Returns [] outside Tauri.
export async function listDevices(): Promise<string[]> {
  if (!isTauriEnv()) return [];
  return invoke<string[]>("capture_list_devices");
}

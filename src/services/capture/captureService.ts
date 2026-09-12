/// Capture service — BUS-9.
///
/// Wraps Tauri IPC commands for the native capture coordinator.
/// Emits session events via a listener registered on the global Tauri event
/// channel. The renderer never receives PCM, audio handles, or file paths.
///
/// Only one session may be active at a time; the native coordinator enforces
/// this and returns "busy" if a second start is attempted.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { CaptureEvent } from "./types";

const CAPTURE_EVENT = "capture:event";

/// Subscribe to capture events from the native coordinator.
/// Returns an unlisten function; call it on component unmount.
export async function onCaptureEvent(
  handler: (event: CaptureEvent) => void,
): Promise<UnlistenFn> {
  return listen<CaptureEvent>(CAPTURE_EVENT, (e) => {
    handler(e.payload);
  });
}

/// Query current microphone permission without prompting.
/// The result arrives as a `permission-status` CaptureEvent.
export function queryPermission(): void {
  void invoke("capture_query_permission");
}

/// Request microphone permission (prompts when not-determined).
/// Result arrives as a `permission-status` CaptureEvent.
export function requestPermission(): void {
  void invoke("capture_request_permission");
}

/// Start a 10-second mic test session.
/// Events: `capture-started`, `activity-detected`?, `test-complete`.
/// Returns the IPC result string ("ok") or a category error string.
export async function startMicTest(
  preferredDevice?: string,
): Promise<string> {
  return invoke<string>("capture_start", {
    preferredDevice: preferredDevice ?? null,
    testMode: true,
  });
}

/// Stop any active capture session. Idempotent.
export function stopCapture(): void {
  void invoke("capture_stop");
}

/// Return true when a capture session is currently active.
export async function isCaptureActive(): Promise<boolean> {
  return invoke<boolean>("capture_is_active");
}

/// Enumerate input device names. Result also arrives as `device-list` event.
export async function listDevices(): Promise<string[]> {
  return invoke<string[]>("capture_list_devices");
}

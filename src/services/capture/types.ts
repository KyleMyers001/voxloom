/// Capture service types — BUS-9.
/// No PCM bytes or audio handles appear anywhere in this file.

export type PermissionStatus =
  | "not-determined"
  | "authorized"
  | "denied"
  | "restricted";

export interface TestCaptureMetadata {
  readonly detected_activity: boolean;
  readonly duration_secs: number;
  readonly frame_count: number;
  readonly peak_level: number;
}

/// All events the native coordinator may emit.
export type CaptureEvent =
  | {
      kind: "permission-status";
      status: PermissionStatus;
    }
  | {
      device_name: string;
      kind: "capture-started";
    }
  | { kind: "activity-detected" }
  | {
      kind: "test-complete";
      metadata: TestCaptureMetadata;
    }
  | { kind: "capture-stopped" }
  | { kind: "capture-cancelled" }
  | {
      devices: string[];
      kind: "device-list";
    }
  | {
      category: CaptureErrorCategory;
      kind: "capture-error";
      message: string;
    };

/// Stable error categories matching the Rust coordinator.
export type CaptureErrorCategory =
  | "busy"
  | "capture-unavailable"
  | "input-limit-exceeded"
  | "permission-denied";

/// Capture session state surfaced to the UI.
export type CaptureState =
  | { kind: "idle" }
  | { kind: "requesting-permission" }
  | {
      device: string;
      generation: string;
      kind: "active";
    }
  | {
      generation: string;
      kind: "test-running";
      started_at: number;
    }
  | {
      kind: "test-complete";
      metadata: TestCaptureMetadata;
    }
  | { kind: "cancelled" }
  | {
      category: CaptureErrorCategory;
      kind: "error";
      message: string;
    };

/// True when the UI should not permit starting a new session.
export function isCaptureSessionActive(
  state: CaptureState,
): boolean {
  return state.kind === "active" || state.kind === "test-running";
}

/// Capture service types — BUS-9.
///
/// All values crossing this boundary carry only safe state metadata.
/// No PCM bytes, audio handles, or file paths are present.

export type PermissionStatus =
  | "not-determined"
  | "authorized"
  | "denied";

export interface TestCaptureMetadata {
  readonly detected_activity: boolean;
  readonly duration_secs: number;
  readonly frame_count: number;
  readonly peak_level: number;
}

/// Discriminated union of all events emitted from the native capture layer.
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
  | { device: string; kind: "active" }
  | {
      kind: "test-running";
      started_at: number;
    }
  | {
      kind: "test-complete";
      metadata: TestCaptureMetadata;
    }
  | {
      category: CaptureErrorCategory;
      kind: "error";
      message: string;
    };

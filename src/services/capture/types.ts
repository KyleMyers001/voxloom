/// Capture service types — BUS-9.
/// No PCM bytes or audio handles cross this boundary.

export type CaptureMode = "full" | "test";
export type InputDeviceId = string;

export const SYSTEM_DEFAULT_DEVICE_ID: InputDeviceId = "system-default";

export type PermissionStatus =
  | "not-determined"
  | "authorized"
  | "denied"
  | "restricted";

export interface CaptureStatus {
  readonly generation: number;
  readonly mode: CaptureMode;
  readonly request_id: string;
}

export interface InputDeviceDescriptor {
  readonly available: boolean;
  readonly id: InputDeviceId;
  readonly label: string;
}

export interface TestCaptureMetadata {
  readonly detected_activity: boolean;
  readonly duration_secs: number;
  readonly frame_count: number;
  readonly peak_level: number;
}

interface SessionCorrelation {
  readonly generation: number;
  readonly request_id: string;
}

export type CaptureEvent =
  | (SessionCorrelation & {
      kind: "permission-status";
      status: PermissionStatus;
    })
  | (SessionCorrelation & {
      device_name: string;
      kind: "capture-started";
    })
  | (SessionCorrelation & { kind: "activity-detected" })
  | (SessionCorrelation & {
      /** Rate-limited RMS metadata, never PCM or audio samples. */
      kind: "capture-level";
      level: number;
    })
  | (SessionCorrelation & {
      kind: "test-complete";
      metadata: TestCaptureMetadata;
    })
  | (SessionCorrelation & {
      kind: "capture-stopped";
      /** Present after stop or 120s/capacity limit; PCM stays native-side. */
      audio?: {
        duration_ms: number;
        id: string;
        sample_rate_hz: number;
      };
    })
  | (SessionCorrelation & { kind: "capture-cancelled" })
  | (SessionCorrelation & {
      category: CaptureErrorCategory;
      kind: "capture-error";
      message: string;
    });

export type CaptureErrorCategory =
  | "busy"
  | "capture-unavailable"
  | "input-limit-exceeded"
  | "permission-denied";

export type CaptureState =
  | { kind: "idle" }
  | { kind: "requesting-permission" }
  | { kind: "switching-device" }
  | {
      device: string;
      generation: number;
      kind: "active";
      request_id: string;
    }
  | {
      generation: number | null;
      kind: "test-running";
      request_id: string;
      started_at: number;
    }
  | {
      kind: "test-complete";
      metadata: TestCaptureMetadata;
    }
  | { kind: "cancelled" }
  | {
      /** Clean stop / 120s bound — optional opaque audio for STT dogfood. */
      audio?: {
        duration_ms: number;
        id: string;
        sample_rate_hz: number;
      };
      kind: "stopped";
    }
  | {
      category: CaptureErrorCategory;
      kind: "error";
      message: string;
    };

export function isCaptureSessionActive(state: CaptureState): boolean {
  return state.kind === "active" || state.kind === "test-running";
}

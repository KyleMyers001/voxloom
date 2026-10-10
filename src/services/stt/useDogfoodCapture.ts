/// Wire full capture stop → dogfoodTranscribeAndCopy on the main UI.
/// Automatic STT + delivery after a clean stop; cancel discards with no STT.
/// Snapshots intended target at capture start (ADR §4 invocation policy).
/// Shared by Home Start and global hold/latch — start() must not activate
/// Voxloom; gesture callers rely on the other app still being frontmost.
/// Never silent-downloads missing models — surfaces a clear UI error instead.

import { useCallback, useEffect, useRef, useState } from "react";

import { createDogfoodRecord } from "../../domain/records";
import type { DictationRecord, WritingStyle } from "../../domain/types";
import type { ClipboardAdapter } from "../clipboard";
import {
  createStubDeliveryAdapter,
  createTauriDeliveryAdapter,
  type DeliveryPlatformAdapter,
  type TargetSnapshot,
} from "../delivery";
import {
  SYSTEM_DEFAULT_DEVICE_ID,
  type CaptureState,
} from "../capture/types";
import {
  useCaptureState,
  type UseCaptureStateResult,
} from "../capture/useCaptureState";
import type { SttModelStore } from "./contracts";
import {
  dogfoodTranscribeAndCopy,
  type CaptureAudioMeta,
} from "./dogfoodPath";
import { createSttModelStore } from "./factory";
import { resolveTranscriptionModelId } from "./resolveModelId";
import { SttError, type Transcript } from "./types";

export type DogfoodPhase =
  | "idle"
  | "recording"
  | "transcribing"
  | "success"
  | "error"
  | "cancelled";

export interface UseDogfoodCaptureOptions {
  clipboard: ClipboardAdapter;
  /** Settings `clipboardFallback` (default true). */
  clipboardFallback?: boolean;
  /** Settings `transcriptionModel` (resolved before STT). */
  modelId: string;
  /** Clock for history `createdAt` (defaults to Date.now). */
  now?: () => number;
  /**
   * Session History append after a non-blank dogfood transcript.
   * Cancel / blank audio / STT errors never call this.
   */
  onHistoryRecord?: (record: DictationRecord) => void;
  /** Toast / announce callback for loading / success / error. */
  onToast?: (message: string) => void;
  /** Preferred mic id; system default means omit and let native pick. */
  preferredDeviceId?: string;
  /** Writing style stamped onto the history row. */
  style?: WritingStyle;
  /** Test seam: inject capture API instead of the live hook result. */
  captureApi?: UseCaptureStateResult;
  /** Test seam: model store (status checks; never download). */
  createModelStore?: () => SttModelStore;
  /** Test seam: dogfood path. */
  dogfood?: typeof dogfoodTranscribeAndCopy;
  /** Test seam: delivery platform (snapshot / insert / clipboard). */
  deliveryPlatform?: DeliveryPlatformAdapter;
}

export interface UseDogfoodCaptureResult {
  cancel: () => void;
  captureState: CaptureState;
  /** Invocation-time intended target (null until start snapshots). */
  intendedTarget: TargetSnapshot | null;
  message: string | null;
  phase: DogfoodPhase;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  transcript: Transcript | null;
}

function errorText(error: unknown): string {
  if (error instanceof SttError) {
    if (error.code === "model-missing") {
      return (
        `${error.message} Open Settings → Speech-to-text models and `
        + "Download the selected model first."
      );
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function missingModelMessage(modelId: string, status: string | null): string {
  const detail = status ? ` (status: ${status})` : "";
  return (
    `Model “${modelId}” is not downloaded${detail}. `
    + "Open Settings → Speech-to-text models and Download it first "
    + "(no silent download)."
  );
}

function resolvePlatform(
  clipboard: ClipboardAdapter,
  injected?: DeliveryPlatformAdapter,
): DeliveryPlatformAdapter {
  if (injected) return injected;
  try {
    return createTauriDeliveryAdapter(clipboard);
  } catch {
    return createStubDeliveryAdapter({ clipboard });
  }
}

export function useDogfoodCapture(
  options: UseDogfoodCaptureOptions,
): UseDogfoodCaptureResult {
  const liveCapture = useCaptureState();
  const capture = options.captureApi ?? liveCapture;

  const [phase, setPhase] = useState<DogfoodPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [intendedTarget, setIntendedTarget] =
    useState<TargetSnapshot | null>(null);

  const dogfoodRef = useRef(options.dogfood ?? dogfoodTranscribeAndCopy);
  dogfoodRef.current = options.dogfood ?? dogfoodTranscribeAndCopy;
  const storeRef = useRef(
    (options.createModelStore ?? createSttModelStore)(),
  );
  if (options.createModelStore) {
    storeRef.current = options.createModelStore();
  }

  const modelIdRef = useRef(options.modelId);
  modelIdRef.current = options.modelId;
  const clipboardRef = useRef(options.clipboard);
  clipboardRef.current = options.clipboard;
  const clipboardFallbackRef = useRef(options.clipboardFallback !== false);
  clipboardFallbackRef.current = options.clipboardFallback !== false;
  const toastRef = useRef(options.onToast);
  toastRef.current = options.onToast;
  const historyRef = useRef(options.onHistoryRecord);
  historyRef.current = options.onHistoryRecord;
  const styleRef = useRef(options.style ?? "formal");
  styleRef.current = options.style ?? "formal";
  const nowRef = useRef(options.now ?? Date.now);
  nowRef.current = options.now ?? Date.now;
  const platformRef = useRef<DeliveryPlatformAdapter>(
    resolvePlatform(options.clipboard, options.deliveryPlatform),
  );
  platformRef.current = resolvePlatform(
    options.clipboard,
    options.deliveryPlatform,
  );
  const intendedRef = useRef<TargetSnapshot | null>(null);
  /** Set by stop/cancel so a finish that races start still terminates. */
  const stopRequestedRef = useRef(false);
  /** Bumped on cancel/new session so stale transcription runs are ignored. */
  const runGenerationRef = useRef(0);

  const announce = useCallback((text: string) => {
    setMessage(text);
    toastRef.current?.(text);
  }, []);

  const ensureModelAvailable = useCallback(async (rawModelId: string) => {
    const modelId = resolveTranscriptionModelId(rawModelId);
    const info = await storeRef.current.status(modelId);
    if (!info || info.status !== "available") {
      throw new SttError(
        "model-missing",
        missingModelMessage(modelId, info?.status ?? null),
      );
    }
    return modelId;
  }, []);

  const runDogfood = useCallback(async (audio: CaptureAudioMeta) => {
    const generation = runGenerationRef.current;
    const isStale = () => generation !== runGenerationRef.current;
    setPhase("transcribing");
    announce("Transcribing…");
    try {
      const modelId = await ensureModelAvailable(modelIdRef.current);
      const result = await dogfoodRef.current({
        audio,
        clipboard: clipboardRef.current,
        clipboardFallback: clipboardFallbackRef.current,
        deliveryPlatform: platformRef.current,
        intended: intendedRef.current,
        modelId,
      });
      if (isStale()) return;
      setTranscript(result.transcript);
      setPhase("success");
      const record = createDogfoodRecord({
        durationMs: audio.duration_ms,
        id: `dogfood-${audio.id}`,
        model: modelId,
        now: nowRef.current(),
        status: result.delivery.status,
        style: styleRef.current,
        text: result.transcript.text,
      });
      if (record) {
        historyRef.current?.(record);
      }
      announce(result.delivery.message);
    } catch (error: unknown) {
      if (isStale()) return;
      setPhase("error");
      announce(errorText(error));
    }
  }, [announce, ensureModelAvailable]);

  // Auto dogfood on clean stop (user stop or 120s/capacity bound).
  const handledAudioIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (capture.captureState.kind === "cancelled") {
      setPhase("cancelled");
      setMessage("Capture cancelled — nothing transcribed.");
      return;
    }
    if (capture.captureState.kind === "error") {
      setPhase("error");
      setMessage(capture.captureState.message);
      return;
    }
    if (capture.captureState.kind !== "stopped") return;
    const audio = capture.captureState.audio;
    if (!audio) {
      setPhase("error");
      announce("Capture stopped without audio — nothing to transcribe.");
      return;
    }
    if (handledAudioIdRef.current === audio.id) return;
    handledAudioIdRef.current = audio.id;
    void runDogfood(audio);
  }, [announce, capture.captureState, runDogfood]);

  const start = useCallback(async () => {
    setTranscript(null);
    setMessage(null);
    handledAudioIdRef.current = null;
    stopRequestedRef.current = false;
    try {
      await ensureModelAvailable(modelIdRef.current);
    } catch (error: unknown) {
      setPhase("error");
      announce(errorText(error));
      return;
    }

    // ADR §4: snapshot intended target at invocation (capture start).
    try {
      const snap = await platformRef.current.snapshotTarget();
      intendedRef.current = snap;
      setIntendedTarget(snap);
    } catch {
      intendedRef.current = null;
      setIntendedTarget(null);
    }

    // Hold release may have already requested stop while we were snapshotting.
    if (stopRequestedRef.current) {
      setPhase("cancelled");
      setMessage("Capture cancelled — nothing transcribed.");
      return;
    }

    const deviceId = options.preferredDeviceId
      && options.preferredDeviceId !== SYSTEM_DEFAULT_DEVICE_ID
      ? options.preferredDeviceId
      : undefined;

    runGenerationRef.current += 1;
    setPhase("recording");
    announce("Listening…");
    try {
      await capture.startFullCaptureSession(deviceId);
    } catch (error: unknown) {
      setPhase("error");
      announce(errorText(error));
      return;
    }
    if (stopRequestedRef.current) {
      try {
        await capture.stopFullCapture();
      } catch (error: unknown) {
        setPhase("error");
        announce(errorText(error));
      }
    }
  }, [
    announce,
    capture,
    ensureModelAvailable,
    options.preferredDeviceId,
  ]);

  const stop = useCallback(async () => {
    stopRequestedRef.current = true;
    try {
      await capture.stopFullCapture();
    } catch (error: unknown) {
      setPhase("error");
      announce(errorText(error));
    }
  }, [announce, capture]);

  const cancel = useCallback(() => {
    runGenerationRef.current += 1;
    stopRequestedRef.current = true;
    handledAudioIdRef.current = null;
    intendedRef.current = null;
    setIntendedTarget(null);
    try {
      capture.cancelActiveCapture();
    } finally {
      setPhase("cancelled");
      setMessage("Capture cancelled — nothing transcribed.");
    }
  }, [capture]);

  return {
    cancel,
    captureState: capture.captureState,
    intendedTarget,
    message,
    phase,
    start,
    stop,
    transcript,
  };
}


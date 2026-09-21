/// Tauri-backed whisper STT adapter — BUS-10.
/// Talks to native `stt_*` commands. No silent downloads; modelId is explicit.
///
/// Native `stt_download_model` / `stt_transcribe` are async commands that run
/// blocking work on a pool (`spawn_blocking`). The webview stays responsive;
/// `invoke` still resolves only when the native work finishes (or errors).

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { SttEngine, SttModelStore } from "./contracts";
import {
  SttError,
  type AudioBufferHandle,
  type SttDownloadProgress,
  type SttErrorCode,
  type SttModelInfo,
  type Transcript,
} from "./types";

const DOWNLOAD_PROGRESS_EVENT = "stt:download-progress";

interface NativeSttError {
  code?: string;
  message?: string;
}

function mapNativeError(error: unknown): SttError {
  if (error instanceof SttError) return error;
  const payload =
    typeof error === "string"
      ? safeParse(error)
      : ((error as NativeSttError) ?? {});
  const code = normalizeCode(payload?.code);
  const message =
    payload?.message ??
    (typeof error === "string" ? error : "STT native call failed");
  return new SttError(code, message);
}

function safeParse(raw: string): NativeSttError | null {
  try {
    return JSON.parse(raw) as NativeSttError;
  } catch {
    return { message: raw };
  }
}

function normalizeCode(code: string | undefined): SttErrorCode {
  switch (code) {
    case "cancelled":
    case "download-failed":
    case "model-missing":
    case "transcribe-failed":
    case "unsupported-audio":
    case "engine-unavailable":
      return code;
    default:
      return "transcribe-failed";
  }
}

function requireModelId(modelId: string): string {
  const id = modelId.trim();
  if (!id) {
    throw new SttError(
      "model-missing",
      "SttEngine requires an explicit non-empty modelId",
    );
  }
  return id;
}

/**
 * Native model store. Constructing the store does not download anything.
 * `download` must be called after explicit user intent.
 *
 * Progress events may report ratios up to ~0.999 while bytes stream; ratio
 * `1.0` and the resolved `download()` promise both mean the file is on disk.
 * Do not treat intermediate progress as completion.
 */
export function createWhisperSttModelStore(): SttModelStore {
  return {
    async list() {
      if (!isTauri()) {
        throw new SttError(
          "engine-unavailable",
          "Whisper model store requires the Tauri shell",
        );
      }
      try {
        return await invoke<SttModelInfo[]>("stt_list_models");
      } catch (error) {
        throw mapNativeError(error);
      }
    },

    async status(modelId) {
      if (!isTauri()) {
        throw new SttError(
          "engine-unavailable",
          "Whisper model store requires the Tauri shell",
        );
      }
      try {
        return await invoke<SttModelInfo | null>("stt_model_status", {
          modelId,
        });
      } catch (error) {
        throw mapNativeError(error);
      }
    },

    async download(modelId, onProgress) {
      if (!isTauri()) {
        throw new SttError(
          "engine-unavailable",
          "Whisper model store requires the Tauri shell",
        );
      }
      let unlisten: UnlistenFn | undefined;
      try {
        // Subscribe before invoke so early progress events are not missed.
        // Completion is the invoke resolution — not a progress ratio alone.
        if (onProgress) {
          unlisten = await listen<SttDownloadProgress>(
            DOWNLOAD_PROGRESS_EVENT,
            (event) => {
              if (event.payload.modelId === modelId) {
                onProgress(event.payload);
              }
            },
          );
        }
        await invoke("stt_download_model", { modelId });
      } catch (error) {
        throw mapNativeError(error);
      } finally {
        unlisten?.();
      }
    },

    async cancel(modelId) {
      if (!isTauri()) {
        throw new SttError(
          "engine-unavailable",
          "Whisper model store requires the Tauri shell",
        );
      }
      try {
        // Sync native command — safe while download runs on the blocking pool.
        await invoke("stt_cancel_download", { modelId });
      } catch (error) {
        throw mapNativeError(error);
      }
    },
  };
}

export interface WhisperEngineOptions {
  /** Explicit model id — required; never auto-selected silently. */
  modelId: string;
}

/**
 * Native whisper engine bound to an explicit modelId.
 * Does not download on construct; transcribe fails with model-missing
 * until the user has downloaded that model via SttModelStore.
 *
 * `transcribe` awaits the async native command (whisper off the UI thread).
 */
export function createWhisperSttEngine(
  options: WhisperEngineOptions,
): SttEngine {
  const modelId = requireModelId(options.modelId);

  return {
    modelId,
    async transcribe(audio: AudioBufferHandle): Promise<Transcript> {
      if (!audio.id) {
        throw new SttError(
          "unsupported-audio",
          "Audio buffer handle requires a non-empty id",
        );
      }
      if (!isTauri()) {
        throw new SttError(
          "engine-unavailable",
          "Whisper STT requires the Tauri shell",
        );
      }
      try {
        return await invoke<Transcript>("stt_transcribe", {
          modelId,
          bufferId: audio.id,
        });
      } catch (error) {
        throw mapNativeError(error);
      }
    },
  };
}

export { isTauri as isWhisperNativeAvailable };

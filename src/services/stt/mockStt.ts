import type { SttEngine, SttModelStore } from "./contracts";
import {
  DEFAULT_STT_MODEL_ID,
  STT_MODEL_CATALOG,
  SttError,
  type AudioBufferHandle,
  type SttDownloadProgress,
  type SttModelInfo,
  type Transcript,
} from "./types";

const DETERMINISTIC_TEXT = "mock transcript from local STT scaffold";

export interface MockSttOptions {
  /** Explicit model id bound to the engine (required for real path parity). */
  modelId?: string;
  /** Deterministic transcript text (defaults to a fixed scaffold string). */
  transcriptText?: string;
  /** Simulated download steps (default 3). Progress fires between 0 and 1. */
  downloadSteps?: number;
}

interface MutableModel extends SttModelInfo {
  status: SttModelInfo["status"];
}

/**
 * In-memory model store. Download only runs when `download` is called —
 * never on construct or list/status.
 */
export function createMockSttModelStore(
  options: MockSttOptions = {},
): SttModelStore {
  const steps = Math.max(1, options.downloadSteps ?? 3);
  const models = new Map<string, MutableModel>(
    STT_MODEL_CATALOG.map((m) => [
      m.id,
      { ...m, status: "missing" as const },
    ]),
  );
  const cancelled = new Set<string>();
  const inFlight = new Set<string>();

  return {
    async list() {
      return [...models.values()];
    },

    async status(modelId) {
      return models.get(modelId) ?? null;
    },

    async download(modelId, onProgress) {
      const model = models.get(modelId);
      if (!model) {
        throw new SttError("download-failed", `Unknown model: ${modelId}`);
      }
      if (inFlight.has(modelId)) {
        throw new SttError(
          "download-failed",
          `Download already in progress: ${modelId}`,
        );
      }

      cancelled.delete(modelId);
      inFlight.add(modelId);
      model.status = "downloading";

      try {
        for (let i = 1; i <= steps; i += 1) {
          if (cancelled.has(modelId)) {
            model.status = "missing";
            throw new SttError(
              "cancelled",
              `Download cancelled: ${modelId}`,
            );
          }
          const ratio = i / steps;
          const progress: SttDownloadProgress = {
            bytesReceived: Math.floor(model.sizeBytes * ratio),
            bytesTotal: model.sizeBytes,
            modelId,
            ratio,
          };
          onProgress?.(progress);
        }
        model.status = "available";
      } catch (error) {
        if (error instanceof SttError && error.code === "cancelled") {
          throw error;
        }
        model.status = "failed";
        throw error;
      } finally {
        inFlight.delete(modelId);
      }
    },

    async cancel(modelId) {
      if (!models.has(modelId)) {
        throw new SttError("download-failed", `Unknown model: ${modelId}`);
      }
      cancelled.add(modelId);
      const model = models.get(modelId);
      if (model?.status === "downloading") {
        model.status = "missing";
      }
    },
  };
}

function requireModelId(modelId: string | undefined): string {
  const id = (modelId ?? "").trim();
  if (!id) {
    throw new SttError(
      "model-missing",
      "SttEngine requires an explicit non-empty modelId",
    );
  }
  return id;
}

/** Deterministic mock engine — no whisper.cpp, no network. */
export function createMockSttEngine(
  options: MockSttOptions = {},
): SttEngine {
  const modelId = requireModelId(options.modelId ?? DEFAULT_STT_MODEL_ID);
  const text = options.transcriptText ?? DETERMINISTIC_TEXT;

  return {
    modelId,
    async transcribe(audio: AudioBufferHandle): Promise<Transcript> {
      if (!audio.id) {
        throw new SttError(
          "unsupported-audio",
          "Audio buffer handle requires a non-empty id",
        );
      }
      return { language: "en", text };
    },
  };
}

export { DETERMINISTIC_TEXT as MOCK_TRANSCRIPT_TEXT };

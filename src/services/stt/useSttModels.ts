/// Settings STT model list / download / select.
/// Opening this hook (Settings mount) only lists status — never downloads.

import { useCallback, useEffect, useRef, useState } from "react";

import type { SttModelStore } from "./contracts";
import { createSttModelStore } from "./factory";
import { resolveTranscriptionModelId } from "./resolveModelId";
import { SttError, type SttDownloadProgress, type SttModelInfo } from "./types";

export interface UseSttModelsOptions {
  /** Persist selection (Settings `transcriptionModel`). */
  onSelect: (modelId: string) => void;
  selectedModelId: string;
  /** Inject store for tests; default is whisper-or-mock factory. */
  store?: SttModelStore;
}

export interface UseSttModelsResult {
  cancelDownload: (modelId: string) => Promise<void>;
  downloadModel: (modelId: string) => Promise<void>;
  error: string | null;
  loading: boolean;
  models: readonly SttModelInfo[];
  progress: SttDownloadProgress | null;
  refresh: () => Promise<void>;
  selectModel: (modelId: string) => void;
  selectedModelId: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof SttError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function useSttModels(options: UseSttModelsOptions): UseSttModelsResult {
  const storeRef = useRef(options.store ?? createSttModelStore());
  if (options.store) storeRef.current = options.store;

  const [models, setModels] = useState<readonly SttModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<SttDownloadProgress | null>(null);
  const selectedModelId = resolveTranscriptionModelId(options.selectedModelId);
  const onSelectRef = useRef(options.onSelect);
  onSelectRef.current = options.onSelect;

  const refresh = useCallback(async () => {
    const list = await storeRef.current.list();
    setModels(list);
  }, []);

  // List / status only on mount — ADR: no silent download on Settings open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const list = await storeRef.current.list();
        if (!cancelled) setModels(list);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const downloadModel = useCallback(async (modelId: string) => {
    setError(null);
    setProgress({
      bytesReceived: 0,
      bytesTotal: 0,
      modelId,
      ratio: 0,
    });
    try {
      await storeRef.current.download(modelId, (next) => {
        setProgress(next);
      });
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
      try {
        await refresh();
      } catch {
        /* keep prior error */
      }
      throw err;
    } finally {
      setProgress((current) =>
        current?.modelId === modelId ? null : current,
      );
    }
  }, [refresh]);

  const cancelDownload = useCallback(async (modelId: string) => {
    setError(null);
    try {
      await storeRef.current.cancel(modelId);
    } catch (err) {
      setError(errorMessage(err));
      throw err;
    } finally {
      try {
        await refresh();
      } catch {
        /* ignore refresh failure after cancel */
      }
    }
  }, [refresh]);

  const selectModel = useCallback((modelId: string) => {
    const id = resolveTranscriptionModelId(modelId);
    onSelectRef.current(id);
  }, []);

  return {
    cancelDownload,
    downloadModel,
    error,
    loading,
    models,
    progress,
    refresh,
    selectModel,
    selectedModelId,
  };
}

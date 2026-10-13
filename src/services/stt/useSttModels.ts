/// Settings STT model list / download / select.
/// Opening this hook (Settings mount) only lists status — never downloads.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { SttModelStore } from './contracts';
import { createSttModelStore } from './factory';
import { resolveTranscriptionModelId } from './resolveModelId';
import { SttError, type SttDownloadProgress, type SttModelInfo } from './types';

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
  /** Per-model download failure from this session ("Download failed: … Nothing was saved."). */
  failures: Readonly<Record<string, string>>;
  /** List load failed; `reload()` is the "Try again" action. */
  listError: string | null;
  loading: boolean;
  reload: () => Promise<void>;
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
  const inFlightRef = useRef<string | null>(null);
  if (options.store) storeRef.current = options.store;

  const [models, setModels] = useState<readonly SttModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<SttDownloadProgress | null>(null);
  const selectedModelId = resolveTranscriptionModelId(options.selectedModelId);
  const onSelectRef = useRef(options.onSelect);
  onSelectRef.current = options.onSelect;

  const refresh = useCallback(async () => {
    const list = await storeRef.current.list();
    setModels(list);
  }, []);

  const aliveRef = useRef(true);
  const reload = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const list = await storeRef.current.list();
      if (aliveRef.current) setModels(list);
    } catch (err) {
      if (aliveRef.current) setListError(errorMessage(err));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  // List / status only on mount — ADR: no silent download on Settings open.
  useEffect(() => {
    aliveRef.current = true;
    void reload();
    return () => {
      aliveRef.current = false;
    };
  }, [reload]);

  // Also the Retry action: it clears the row's failure as the new attempt starts.
  const downloadModel = useCallback(async (modelId: string) => {
    // BUS-52: never two downloads at once, even if a stale button fires.
    if (inFlightRef.current) throw new SttError('download-failed', 'Another model is downloading');
    inFlightRef.current = modelId;
    setError(null);
    setFailures((prev) => {
      const next = { ...prev };
      delete next[modelId];
      return next;
    });
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
      const cancelled = err instanceof SttError && err.code === 'cancelled';
      if (!cancelled) {
        setFailures((prev) => ({
          ...prev,
          [modelId]: `Download failed: ${errorMessage(err)}. Nothing was saved.`,
        }));
      }
      try {
        await refresh();
      } catch {
        /* keep prior error */
      }
      throw err;
    } finally {
      inFlightRef.current = null;
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
    failures,
    listError,
    loading,
    reload,
    models,
    progress,
    refresh,
    selectModel,
    selectedModelId,
  };
}

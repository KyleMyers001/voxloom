/// Settings STT model list / download / select.
/// Opening this hook (Settings mount) only lists status — never downloads.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { SttModelStore } from './contracts';
import { createSttModelStore } from './factory';
import { resolveTranscriptionModelId } from './resolveModelId';
import { listenModelsChanged } from './modelsChanged';
import { useDownloadPoll } from './useDownloadPoll';
import { SttError, type SttDownloadProgress, type SttModelInfo } from './types';

/** BUS-35 checksum failure copy (hashes are only in the native log). */
export const DOWNLOAD_DAMAGED = 'Download was damaged. Nothing was saved.';

/** A model file on disk that couldn't be opened (row and dictation copy). */
export const MODEL_UNREADABLE =
  'Couldn\'t open the model file. Try again, or download it again if this keeps happening.';

/** Row copy for a model file that opened but couldn't be read (Retry download is next to it). */
export const MODEL_READ_FAILED = 'Couldn\'t read the model file. Download it again.';

/** Row copy for a native `failureReason`; damaged uses ModelCard's default. */
export function failureRowCopy(reason: SttModelInfo['failureReason']): string | undefined {
  if (reason === 'unreadable') return MODEL_UNREADABLE;
  if (reason === 'read-failed') return MODEL_READ_FAILED;
  return undefined;
}

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

  // Re-list when the startup check finishes a model file (damaged → Retry).
  useEffect(() => {
    let stop: (() => void) | null = null;
    let live = true;
    void listenModelsChanged(() => { void refresh().catch(() => undefined); })
      .then((un) => { if (live) stop = un; else un(); }, () => undefined);
    return () => {
      live = false;
      stop?.();
    };
  }, [refresh]);

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
        // Ignore late or stray progress once this download is no longer the one in flight.
        if (inFlightRef.current === modelId) setProgress(next);
      });
      await refresh();
    } catch (err) {
      const cancelled = err instanceof SttError && err.code === 'cancelled';
      if (!cancelled) {
        setFailures((prev) => ({
          ...prev,
          [modelId]: err instanceof SttError && err.code === 'download-corrupted'
            ? DOWNLOAD_DAMAGED
            : `Download failed: ${errorMessage(err).replace(/\.+$/, '')}. Nothing was saved.`,
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

  const aliveRefresh = useCallback(async () => {
    const list = await storeRef.current.list();
    if (aliveRef.current) setModels(list);
  }, []);
  useDownloadPoll(models, progress !== null, aliveRefresh);

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

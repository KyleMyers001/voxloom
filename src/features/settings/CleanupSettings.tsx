import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CLEANUP_MODEL_ID,
  createTauriCleanupModelStore,
  type CleanupModelStore,
  type CleanupModelStatus,
} from '../../services/cleanup';

interface CleanupSettingsProps {
  enabled: boolean;
  isNative: boolean;
  modelId: string | null;
  modelStore?: CleanupModelStore;
  onEnabledChange: (enabled: boolean) => void;
  onModelChange: (modelId: string) => void;
}

export function CleanupSettings({
  enabled,
  isNative,
  modelId,
  modelStore,
  onEnabledChange,
  onModelChange,
}: CleanupSettingsProps) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<CleanupModelStatus | null>(null);
  const generation = useRef(0);
  const importing = useRef(false);
  const modelIdRef = useRef(modelId);
  const modelChangeRef = useRef(onModelChange);
  const storeRef = useRef(modelStore ?? createTauriCleanupModelStore());
  modelChangeRef.current = onModelChange;
  modelIdRef.current = modelId;
  if (modelStore) storeRef.current = modelStore;

  const readStatus = useCallback(async (request: number) => {
    try {
      const next = await storeRef.current.status();
      if (request !== generation.current) return;
      setStatus(next);
      if (next.available && !modelIdRef.current) {
        modelIdRef.current = next.id;
        modelChangeRef.current(next.id);
      }
    } catch (reason: unknown) {
      if (request !== generation.current) return;
      setStatus(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  const refreshStatus = useCallback(() => {
    // Returning from the native picker can focus the window before import
    // finishes. The import owns its final refresh; focus must not retire it.
    if (!isNative || importing.current) return;
    const request = ++generation.current;
    setError(null);
    setStatus(null);
    void readStatus(request);
  }, [isNative, readStatus]);

  useEffect(() => {
    setLoading(false);
    refreshStatus();
    window.addEventListener('focus', refreshStatus);
    return () => {
      ++generation.current;
      importing.current = false;
      window.removeEventListener('focus', refreshStatus);
    };
  }, [modelStore, refreshStatus]);

  async function importModel() {
    if (!isNative || importing.current) return;
    const request = ++generation.current;
    importing.current = true;
    setError(null);
    setStatus(null);
    setLoading(true);
    try {
      const next = await storeRef.current.importModel();
      if (request !== generation.current) return;
      if (next?.available) {
        modelIdRef.current = next.id;
        modelChangeRef.current(next.id);
      }
    } catch (reason: unknown) {
      if (request === generation.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      // Refresh on success, cancellation, and rejection: the actual installed
      // model and executable are independent of the picker result.
      if (request === generation.current) {
        await readStatus(request);
        if (request === generation.current) {
          importing.current = false;
          setLoading(false);
        }
      }
    }
  }

  const ready = isNative && !loading && status?.available === true
    && status.runtimeAvailable && modelId === status.id;
  return <>
    <div className="field">
      <label>Language-processing model</label>
      <p className="empty-note">
        {!isNative
          ? 'Local cleanup is only available in the native app.'
          : !status
            ? 'Cleanup model status has not been confirmed.'
            : status.available
              ? 'Qwen3 0.6B Q4_K_M is installed locally.'
              : 'No validated cleanup model installed. Import the supported GGUF.'}
        {status && !status.runtimeAvailable
          ? ' The cleanup worker is missing or not executable. Use a worker-equipped build. Reimporting the model will not fix the worker.'
          : ''}
        {status?.available && modelId !== status.id
          ? ' Import to select the supported model for cleanup.'
          : ''}
      </p>
      <button
        aria-label="Language-processing model import"
        className="btn"
        disabled={!isNative || loading}
        onClick={() => { void importModel(); }}
        type="button"
      >
        {loading ? 'Validating…' : 'Import local GGUF…'}
      </button>
      <button
        className="btn"
        disabled={!isNative || loading}
        onClick={refreshStatus}
        type="button"
      >
        Refresh cleanup status
      </button>
      <span className="empty-note">Allowed model: {CLEANUP_MODEL_ID}</span>
      {error && <span className="form-error" role="alert">{error}</span>}
    </div>
    <label className="check">
      <input
        checked={enabled}
        disabled={!enabled && !ready}
        onChange={(event) => onEnabledChange(event.target.checked)}
        type="checkbox"
      />
      Clean transcripts with the imported local model
    </label>
  </>;
}

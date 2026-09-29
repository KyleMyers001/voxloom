import { useEffect, useRef, useState } from 'react';
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
  const modelIdRef = useRef(modelId);
  const modelChangeRef = useRef(onModelChange);
  const storeRef = useRef(modelStore ?? createTauriCleanupModelStore());
  modelChangeRef.current = onModelChange;
  modelIdRef.current = modelId;
  if (modelStore) storeRef.current = modelStore;

  useEffect(() => {
    if (!isNative) return;
    let current = true;
    void storeRef.current.status().then((next) => {
      if (!current) return;
      setStatus(next);
      if (next.available && !modelIdRef.current) {
        modelChangeRef.current(next.id);
      }
    }).catch((reason: unknown) => {
      if (current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
    return () => { current = false; };
  }, [isNative]);

  async function importModel() {
    setError(null);
    setLoading(true);
    try {
      const next = await storeRef.current.importModel();
      if (!next) return;
      setStatus(next);
      onModelChange(next.id);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }

  const ready = status?.available === true
    && status.runtimeAvailable === true;
  return <>
    <div className="field">
      <label>Language-processing model</label>
      <p className="empty-note">
        {status?.available
          ? 'Qwen3 0.6B Q4_K_M is installed locally.'
          : 'No cleanup model installed.'}
        {status && !status.runtimeAvailable
          ? ' This build does not include the cleanup worker.'
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
      <span className="empty-note">Allowed model: {CLEANUP_MODEL_ID}</span>
      {error && <span className="form-error" role="alert">{error}</span>}
    </div>
    <label className="check">
      <input
        checked={enabled}
        disabled={!ready}
        onChange={(event) => onEnabledChange(event.target.checked)}
        type="checkbox"
      />
      Clean transcripts with the imported local model
    </label>
  </>;
}

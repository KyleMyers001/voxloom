import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../app/AppContext';
import { Switch } from '../../components/Switch';
import { isCleanupActive } from '../../domain/cleanup';
import type { CleanupModelStore } from '../../services/cleanup/contracts';
import { createTauriCleanupModelStore } from '../../services/cleanup/tauriAdapter';
import {
  CLEANUP_HELP, CLEANUP_IMPORT, CLEANUP_IMPORTING, CLEANUP_LABEL,
  CLEANUP_MODEL_LABEL, CLEANUP_REFRESH, CLEANUP_SWITCH, CLEANUP_TAG,
  cleanupModelNote, cleanupReady, type CleanupModelView,
} from './cleanupCopy';

const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

/**
 * Local cleanup rows (BUS-16 PR 2c). Turning cleanup on is the only place
 * that writes the explicit `cleanupOptIn` key; it needs a verified model and
 * a bundled worker. Turning it off is always allowed.
 */
export function CleanupSettings({ isNative, modelStore }: {
  isNative: boolean;
  modelStore?: CleanupModelStore;
}) {
  const { settings, state } = useApp();
  const update = settings.update;
  const active = isCleanupActive(state.settings);
  const [view, setView] = useState<CleanupModelView>(
    isNative ? { kind: 'checking' } : { kind: 'browser' },
  );
  const [importing, setImporting] = useState(false);
  const storeRef = useRef<CleanupModelStore | null>(modelStore ?? null);
  if (modelStore) storeRef.current = modelStore;
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!isNative) return;
    const request = ++generation.current;
    setView({ kind: 'checking' });
    try {
      const store = storeRef.current ??= createTauriCleanupModelStore();
      const status = await store.status();
      // Native IPC result: check its shape before trusting it.
      if (typeof status?.available !== 'boolean' || typeof status.runtimeAvailable !== 'boolean') {
        throw new Error('unexpected status from the app');
      }
      if (request === generation.current) setView({ kind: 'status', status });
    } catch (reason: unknown) {
      if (request === generation.current) setView({ kind: 'error', message: message(reason) });
    }
  }, [isNative]);

  useEffect(() => {
    void refresh();
    return () => { generation.current++; };
  }, [refresh]);

  const importModel = async () => {
    setImporting(true);
    try {
      await (storeRef.current ??= createTauriCleanupModelStore()).importModel();
    } catch (reason: unknown) {
      setView({ kind: 'error', message: message(reason) });
      setImporting(false);
      return;
    }
    // Refresh after success or a cancelled picker: the installed model is
    // independent of the picker result.
    await refresh();
    setImporting(false);
  };

  const setActive = (on: boolean) => {
    if (on) {
      if (!cleanupReady(view)) return;
      update({ key: 'cleanupModelId', value: view.status.id });
    }
    // One render batch, so this is one settings.json save.
    update({ key: 'cleanupOptIn', value: on });
    update({ key: 'cleanupEnabled', value: on });
  };

  const noteId = 'settings-cleanup-model-note';
  return <>
    <div className="frow">
      <span className="frow__label">
        <span>{CLEANUP_LABEL}</span>
        <span className="tag">{CLEANUP_TAG}</span>
        <small className="frow__help" id="settings-cleanup-help">{CLEANUP_HELP}</small>
      </span>
      <Switch
        aria-describedby={`settings-cleanup-help ${noteId}`}
        checked={active}
        disabled={!active && !cleanupReady(view)}
        hideLabel
        label={CLEANUP_SWITCH}
        onChange={setActive}
      />
    </div>
    <div className="frow">
      <span className="frow__label">
        <span>{CLEANUP_MODEL_LABEL}</span>
        <small className="frow__help" id={noteId} role="status">{cleanupModelNote(view)}</small>
      </span>
      {isNative && (
        <span className="frow__control">
          <button className="btn" disabled={importing} onClick={() => { void importModel(); }} type="button">
            {importing ? CLEANUP_IMPORTING : CLEANUP_IMPORT}
          </button>
          <button className="btn" disabled={importing} onClick={() => { void refresh(); }} type="button">
            {CLEANUP_REFRESH}
          </button>
        </span>
      )}
    </div>
  </>;
}

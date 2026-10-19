import { useState } from 'react';
import { useApp } from '../../app/AppContext';
import { Switch } from '../../components/Switch';
import { isCleanupActive } from '../../domain/cleanup';
import {
  CLEANUP_HELP, CLEANUP_IMPORT, CLEANUP_IMPORTING, CLEANUP_LABEL,
  CLEANUP_MODEL_LABEL, CLEANUP_REFRESH, CLEANUP_SWITCH, CLEANUP_TAG,
  cleanupModelNote, cleanupReady,
} from './cleanupCopy';
import { cleanupShown, type CleanupModel } from './useCleanupModel';

/**
 * Local cleanup rows (BUS-16 PR 2c). Turning cleanup on is the only place
 * that writes the explicit `cleanupOptIn` key; it needs a verified model and
 * a bundled worker. Turning it off is always allowed. Rendered only when
 * `cleanupShown` says so, the same gate as the writing-style captions.
 */
export function CleanupSettings({ isNative, model }: { isNative: boolean; model: CleanupModel }) {
  const { settings, state } = useApp();
  const update = settings.update;
  const active = isCleanupActive(state.settings);
  const { fail, refresh, store, view } = model;
  const [importing, setImporting] = useState(false);

  const importModel = async () => {
    setImporting(true);
    try {
      await store().importModel();
    } catch (reason: unknown) {
      fail(reason);
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

  if (!cleanupShown(view, active)) return null;

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

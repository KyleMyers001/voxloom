import { useLayoutEffect, useRef, useState } from 'react';
import { useApp } from '../../app/AppContext';
import { Switch } from '../../components/Switch';
import { isCleanupActive } from '../../domain/cleanup';
import {
  CLEANUP_HELP, CLEANUP_IMPORT, CLEANUP_IMPORTING, CLEANUP_LABEL,
  CLEANUP_MODEL_LABEL, CLEANUP_REFRESH, CLEANUP_SWITCH, CLEANUP_TAG,
  cleanupImportNote, cleanupModelNote, cleanupReady,
} from './cleanupCopy';
import { cleanupBlockShown, type CleanupModel } from './useCleanupModel';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]';

function focusableIn(row: Element | null | undefined): HTMLElement | null {
  return row?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
}

/**
 * Local cleanup rows (BUS-16 PR 2c). Turning cleanup on is the only place
 * that writes the explicit `cleanupOptIn` key; it needs a verified model and
 * a bundled worker. Turning it off is always allowed. Rendered only when
 * `cleanupBlockShown` says so: the captions' gate, plus a failed status read.
 */
export function CleanupSettings({ isNative, model }: { isNative: boolean; model: CleanupModel }) {
  const { settings, state } = useApp();
  const update = settings.update;
  const active = isCleanupActive(state.settings);
  const { apply, clearImportError, fail, importError, refresh, store, view } = model;
  const [importing, setImporting] = useState(false);
  const shown = cleanupBlockShown(model, active);
  const firstRow = useRef<HTMLDivElement>(null);
  const lastRow = useRef<HTMLDivElement>(null);
  const focusAfterHide = useRef<HTMLElement | null>(null);
  const checking = view.kind === 'checking';

  // Turning cleanup off can close the gate and remove the focused switch:
  // hand focus to the next control (or the previous one), not the page body.
  useLayoutEffect(() => {
    if (shown || !focusAfterHide.current) return;
    focusAfterHide.current.focus();
    focusAfterHide.current = null;
  }, [shown]);

  const importModel = async () => {
    if (importing) return;
    clearImportError();
    setImporting(true);
    try {
      // The import verifies the file and returns the new status, so there is
      // no second hash. A cancelled picker (null) changed nothing.
      const imported = await store().importModel();
      if (imported) apply(imported);
    } catch (reason: unknown) {
      fail(reason);
    } finally {
      setImporting(false);
    }
  };

  const setActive = (on: boolean) => {
    if (on) {
      if (!cleanupReady(view)) return;
      update({ key: 'cleanupModelId', value: view.status.id });
    }
    if (!on && !cleanupBlockShown(model, false)) {
      focusAfterHide.current = focusableIn(lastRow.current?.nextElementSibling)
        ?? focusableIn(firstRow.current?.previousElementSibling);
    }
    // Sophie's single-key call: only the opt-in is written. The legacy
    // `cleanupEnabled` is left as loaded (one render batch, one save).
    update({ key: 'cleanupOptIn', value: on });
  };

  if (!shown) return null;

  const modelInstalled = view.kind === 'status' && view.status.available;
  // Import failures use their own line (BUS-101), next to the status note.
  const statusNote = cleanupModelNote(view);
  const importNote = importError ? cleanupImportNote(importError, modelInstalled) : null;
  const noteId = 'settings-cleanup-model-note';
  return <>
    <div className="frow" ref={firstRow}>
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
    <div className="frow" ref={lastRow}>
      <span className="frow__label">
        <span>{CLEANUP_MODEL_LABEL}</span>
        <small className="frow__help" id={noteId} role="status">
          {statusNote}
          {statusNote && importNote ? ' ' : null}
          {importNote}
        </small>
      </span>
      {isNative && (
        <span className="frow__control">
          {/* aria-disabled, not disabled: a disabled button drops focus to the body. */}
          <button aria-disabled={importing} className="btn" onClick={() => { void importModel(); }} type="button">
            {importing ? CLEANUP_IMPORTING : CLEANUP_IMPORT}
          </button>
          <button
            aria-disabled={importing || checking}
            className="btn"
            onClick={() => { if (!importing && !checking) void refresh(); }}
            type="button"
          >
            {CLEANUP_REFRESH}
          </button>
        </span>
      )}
    </div>
  </>;
}

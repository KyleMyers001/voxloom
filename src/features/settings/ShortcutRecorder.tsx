import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { comboLabel, KeyCombo, spokenCombo } from '../../components/KeyCombo';
import { captureShortcut } from '../../services/shortcut/shortcutCapture';
import { isLoneModifier } from '../../services/shortcut/loneKey';
import { IDLE, keyUp, modifierDown, otherDown, type LoneTracker } from '../../services/shortcut/loneKeyCapture';
import { useShortcutActive } from '../../services/shortcut/activeShortcut';
import { beginRecordingSuspend } from '../../services/shortcut/recordingSuspend';
import {
  attachRecorder, beginPending, cancelPending, setRecorderStatus, useRecorderStatus, type Status,
} from './recorderStore';
import {
  addAKey, CANCELED, invalidText, NOT_ACTIVE, pendingText, PROMPT, RECORDING, resetText, successText,
} from './shortcutCopy';

interface ShortcutRecorderProps {
  defaultValue: string;
  /** Id of the help text that describes the field. */
  helpId?: string;
  /** Field id; Settings and onboarding each pass their own. */
  id?: string;
  /** Id of the visible label; read before the field's own name. */
  labelId?: string;
  /** Marks the field invalid (e.g. a refused combo). */
  invalid?: boolean;
  /** Id of the error text that describes an invalid field. */
  errorId?: string;
  onChange: (combo: string) => void;
  value: string;
}

export { CONFIRM_TIMEOUT_MS } from './recorderStore';

/**
 * BUS-47: click Record (or Enter/Space on it), press a chord, and it's saved.
 * Focus alone never records, so tabbing through doesn't hijack keys. Esc,
 * Tab and blur cancel and keep the previous shortcut. Used by Settings and
 * onboarding. While recording, keys are read window-wide (capture phase, so
 * Esc can't close a dialog first, and WebKit's unfocused click still works)
 * and the global shortcut can't start dictation (recordingSuspend).
 */
/** With a visible label (labelledby) the field names only its value; standalone it says what it is. */
function recorderName(labelled: boolean, recording: boolean, value: string, active: boolean): string {
  const state = recording ? 'recording' : `${spokenCombo(value)}${active ? '' : `, ${NOT_ACTIVE}`}`;
  return labelled ? state : `Dictation shortcut, ${state}`;
}

export function ShortcutRecorder({
  defaultValue, errorId, helpId = 'settings-shortcut-help', id = 'settings-shortcut', invalid, labelId, onChange, value,
}: ShortcutRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [preview, setPreview] = useState('');
  const status = useRecorderStatus();
  const setStatus = setRecorderStatus;
  const active = useShortcutActive();
  const sawKeyRef = useRef(false);
  const loneRef = useRef<LoneTracker>(IDLE);
  const fieldRef = useRef<HTMLButtonElement>(null);
  const handlersRef = useRef<Record<'down' | 'up', (e: KeyboardEvent) => void>>({ down: () => {}, up: () => {} });
  useEffect(() => attachRecorder(value, onChange));
  useEffect(() => {
    if (!recording) return;
    // Ended on save, cancel, blur and unmount: this cleanup runs for each.
    const endSuspend = beginRecordingSuspend();
    const down = (e: KeyboardEvent) => handlersRef.current.down(e);
    const up = (e: KeyboardEvent) => handlersRef.current.up(e);
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      endSuspend();
    };
  }, [recording]);

  /** Save a combo and announce success only once registration confirms it. */
  const apply = (combo: string, okText: string) => {
    const changed = combo !== value;
    cancelPending();
    if (!changed || !isTauri()) {
      onChange(combo);
      stop({ text: okText, tone: 'ok' });
      return;
    }
    beginPending(combo);
    // "Setting…" first, then save: a result that lands during the save must
    // replace "Setting…", never be overwritten by it.
    stop({ text: pendingText(combo), tone: 'info' });
    onChange(combo);
  };

  const start = () => {
    sawKeyRef.current = false;
    loneRef.current = IDLE;
    setPreview('');
    setRecording(true);
    fieldRef.current?.focus();
    setStatus({ text: RECORDING, tone: 'info' });
  };

  const stop = (next: Status) => {
    setRecording(false);
    setPreview('');
    setStatus(next);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const result = captureShortcut(event);
    if (result.kind === 'cancel' && result.reason === 'tab') {
      stop({ text: CANCELED, tone: 'info' });
      return; // let Tab move focus on
    }
    // Keep the keystroke from app shortcuts and the dialog's Esc-to-close.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (result.kind === 'cancel') {
      stop({ text: CANCELED, tone: 'info' });
    } else if (result.kind === 'modifier-only') {
      const lone = modifierDown(loneRef.current, event.code);
      loneRef.current = lone;
      // A right-hand modifier held alone previews as itself ("⌥ (right)").
      const held = lone.held && !lone.dirty ? lone.held : null;
      setPreview(held && isLoneModifier(held) ? held : result.preview);
    } else if (result.kind === 'invalid') {
      loneRef.current = otherDown(loneRef.current);
      sawKeyRef.current = true;
      setPreview('');
      setStatus({ text: invalidText(result.invalid), tone: 'error' });
    } else {
      loneRef.current = otherDown(loneRef.current);
      apply(result.combo, successText(result.combo));
    }
  };

  const onKeyUp = (n: KeyboardEvent) => {
    n.stopImmediatePropagation();
    const anyModifier = n.altKey || n.ctrlKey || n.metaKey || n.shiftKey;
    const { next, release } = keyUp(loneRef.current, n.code, anyModifier);
    loneRef.current = next;
    if (release.kind === 'captured') {
      apply(release.combo, successText(release.combo));
      return;
    }
    if (release.kind === 'left') {
      setPreview('');
      const invalid = { code: release.code, reason: 'left-modifier', suggest: release.suggest } as const;
      setStatus({ text: invalidText(invalid), tone: 'error' });
      return;
    }
    if (preview && !anyModifier) {
      // Released with only modifiers held, in a chord or one we can't bind.
      loneRef.current = IDLE;
      setPreview('');
      setStatus({ text: addAKey(), tone: 'error' });
    }
  };

  handlersRef.current = { down: onKeyDown, up: onKeyUp };

  const reset = () => apply(defaultValue, resetText(defaultValue));

  return (
    <span className="shortcut-recorder">
      <button
        // Only the help: the role=status line announces itself, so describing
        // the field by it too would read each status twice.
        aria-describedby={invalid && errorId ? `${helpId} ${errorId}` : helpId}
        aria-invalid={invalid || status?.tone === 'error' || undefined}
        aria-labelledby={labelId ? `${labelId} ${id}` : undefined}
        aria-label={recorderName(Boolean(labelId), recording, value, active)}
        aria-pressed={recording}
        className="shortcut-recorder__field"
        data-inactive={!active || undefined}
        data-recording={recording || undefined}
        id={id}
        onBlur={() => recording && stop({ text: CANCELED, tone: 'info' })}
        onClick={() => (recording ? undefined : start())}
        ref={fieldRef}
        type="button"
      >
        {recording
          ? <span className="shortcut-recorder__prompt">{preview ? `${comboLabel(preview)} …` : PROMPT}</span>
          : <>
            <KeyCombo combo={value} />
            {!active && <span aria-hidden="true" className="shortcut-recorder__inactive">({NOT_ACTIVE})</span>}
          </>}
      </button>
      <button className="btn" disabled={value === defaultValue} onClick={reset} type="button">
        Reset to default
      </button>
      <span
        aria-live="polite"
        className="shortcut-recorder__status"
        data-tone={status?.tone}
        id={`${id}-status`}
        role="status"
      >
        {status?.text}
      </span>
    </span>
  );
}

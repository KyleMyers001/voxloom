import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { comboLabel, KeyCombo, spokenCombo } from '../../components/KeyCombo';
import { captureShortcut } from '../../services/shortcut/shortcutCapture';
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
export function ShortcutRecorder({
  defaultValue, helpId = 'settings-shortcut-help', id = 'settings-shortcut', onChange, value,
}: ShortcutRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [preview, setPreview] = useState('');
  const status = useRecorderStatus();
  const setStatus = setRecorderStatus;
  const active = useShortcutActive();
  const sawKeyRef = useRef(false);
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
      setPreview(result.preview);
    } else if (result.kind === 'invalid') {
      sawKeyRef.current = true;
      setPreview('');
      setStatus({ text: invalidText(result.invalid), tone: 'error' });
    } else {
      apply(result.combo, successText(result.combo));
    }
  };

  const onKeyUp = (n: KeyboardEvent) => {
    n.stopImmediatePropagation();
    const anyModifier = n.altKey || n.ctrlKey || n.metaKey || n.shiftKey;
    if (preview && !anyModifier) {
      // Released with only modifiers held: lone modifiers are BUS-46.
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
        aria-describedby={helpId}
        aria-label={recording ? 'Dictation shortcut, recording' : `Dictation shortcut, ${spokenCombo(value)}${active ? '' : `, ${NOT_ACTIVE}`}`}
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

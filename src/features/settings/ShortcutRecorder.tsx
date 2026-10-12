import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { comboLabel, KeyCombo, spokenCombo } from '../../components/KeyCombo';
import { captureShortcut } from '../../services/shortcut/shortcutCapture';
import { useShortcutActive } from '../../services/shortcut/activeShortcut';
import {
  attachRecorder, beginPending, cancelPending, setRecorderStatus, useRecorderStatus, type Status,
} from './recorderStore';
import {
  addAKey, CANCELED, invalidText, NOT_ACTIVE, pendingText, PROMPT, RECORDING, resetText, successText,
} from './shortcutCopy';

interface ShortcutRecorderProps {
  defaultValue: string;
  onChange: (combo: string) => void;
  value: string;
}

export { CONFIRM_TIMEOUT_MS } from './recorderStore';

/**
 * BUS-47: click Record (or Enter/Space on it), press a chord, and it's saved.
 * Focus alone never records, so tabbing through doesn't hijack keys. Esc,
 * Tab and blur cancel and keep the previous shortcut.
 */
export function ShortcutRecorder({ defaultValue, onChange, value }: ShortcutRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [preview, setPreview] = useState('');
  const status = useRecorderStatus();
  const setStatus = setRecorderStatus;
  const active = useShortcutActive();
  const sawKeyRef = useRef(false);
  useEffect(() => attachRecorder(value, onChange));

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
    setStatus({ text: RECORDING, tone: 'info' });
  };

  const stop = (next: Status) => {
    setRecording(false);
    setPreview('');
    setStatus(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    const result = captureShortcut(event.nativeEvent);
    if (result.kind === 'cancel' && result.reason === 'tab') {
      stop({ text: CANCELED, tone: 'info' });
      return; // let Tab move focus on
    }
    // Keep the keystroke away from the in-app shortcut listener while recording.
    event.preventDefault();
    event.stopPropagation();
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

  const onKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    event.stopPropagation();
    const n = event.nativeEvent;
    const anyModifier = n.altKey || n.ctrlKey || n.metaKey || n.shiftKey;
    if (preview && !anyModifier) {
      // Released with only modifiers held: lone modifiers are BUS-46.
      setPreview('');
      setStatus({ text: addAKey(), tone: 'error' });
    }
  };

  const reset = () => apply(defaultValue, resetText(defaultValue));

  return (
    <span className="shortcut-recorder">
      <button
        // Only the help: the role=status line announces itself, so describing
        // the field by it too would read each status twice.
        aria-describedby="settings-shortcut-help"
        aria-label={recording ? 'Dictation shortcut, recording' : `Dictation shortcut, ${spokenCombo(value)}${active ? '' : `, ${NOT_ACTIVE}`}`}
        aria-pressed={recording}
        className="shortcut-recorder__field"
        data-inactive={!active || undefined}
        data-recording={recording || undefined}
        id="settings-shortcut"
        onBlur={() => recording && stop({ text: CANCELED, tone: 'info' })}
        onClick={() => (recording ? undefined : start())}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
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
        id="settings-shortcut-status"
        role="status"
      >
        {status?.text}
      </span>
    </span>
  );
}

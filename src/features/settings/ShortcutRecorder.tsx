import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { comboLabel, KeyCombo, spokenCombo } from '../../components/KeyCombo';
import { captureShortcut } from '../../services/shortcut/shortcutCapture';
import { listenShortcutBound } from '../../services/shortcut/bindingEvents';
import { subscribe } from '../../services/settingsWindow';
import {
  addAKey, CANCELED, inUseText, invalidText, noneActiveText, pendingText, PROMPT, RECORDING,
  resetText, successText, timeoutText,
} from './shortcutCopy';

interface ShortcutRecorderProps {
  defaultValue: string;
  onChange: (combo: string) => void;
  value: string;
}

/** "Ctrl + Meta + Space" → "Control Command Space" for VoiceOver. */
export const spokenShortcut = (combo: string) => spokenCombo(combo);

type Status = { tone: 'error' | 'info' | 'ok'; text: string } | null;

/** How long "Setting…" waits for the main window's result. */
export const CONFIRM_TIMEOUT_MS = 5000;

/**
 * BUS-47: click Record (or Enter/Space on it), press a chord, and it's saved.
 * Focus alone never records, so tabbing through doesn't hijack keys. Esc,
 * Tab and blur cancel and keep the previous shortcut.
 */
export function ShortcutRecorder({ defaultValue, onChange, value }: ShortcutRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [preview, setPreview] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const sawKeyRef = useRef(false);
  /** Combo awaiting the main window's native registration result. */
  const pendingRef = useRef<{ combo: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Combo whose confirmation timed out; a late result still updates status. */
  const lateRef = useRef<{ combo: string } | null>(null);
  /** Last combo confirmed registered; the revert target (null: none active). */
  const confirmedRef = useRef<string | null>(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const clearPending = () => {
    pendingRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  useEffect(() => subscribe(() => listenShortcutBound(({ active, ok, previous, shortcut }) => {
    // Track what the OS holds from every result, even superseded ones, so a
    // late ok for A still makes A the revert target when B is refused.
    const before = confirmedRef.current;
    if (ok) confirmedRef.current = shortcut;
    else if (active !== undefined) confirmedRef.current = active;
    const pending = pendingRef.current?.combo === shortcut ? pendingRef.current
      : lateRef.current?.combo === shortcut ? lateRef.current : null;
    if (!pending) return;
    clearPending();
    lateRef.current = null;
    if (ok) {
      setStatus({ text: successText(shortcut), tone: 'ok' });
      return;
    }
    const kept = confirmedRef.current;
    // Never keep a refused combo. With nothing active, keep the previous one
    // in settings so the next launch retries it.
    const restore = previous ?? before;
    const target = kept ?? restore;
    if (target && target !== shortcut) onChangeRef.current(target);
    setStatus({
      text: kept === null ? noneActiveText(shortcut, restore) : inUseText(shortcut, kept),
      tone: 'error',
    });
  })), []);

  useEffect(() => clearPending, []);

  /** Save a combo and announce success only once registration confirms it. */
  const apply = (combo: string, okText: string) => {
    const changed = combo !== value;
    clearPending();
    if (!changed || !isTauri()) {
      onChange(combo);
      stop({ text: okText, tone: 'ok' });
      return;
    }
    lateRef.current = null;
    pendingRef.current = { combo };
    timerRef.current = setTimeout(() => {
      if (pendingRef.current?.combo !== combo) return;
      lateRef.current = pendingRef.current;
      clearPending();
      setStatus({ text: timeoutText(combo), tone: 'error' });
    }, CONFIRM_TIMEOUT_MS);
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
        aria-label={recording ? 'Dictation shortcut, recording' : `Dictation shortcut, ${spokenShortcut(value)}`}
        aria-pressed={recording}
        className="shortcut-recorder__field"
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
          : <KeyCombo combo={value} />}
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

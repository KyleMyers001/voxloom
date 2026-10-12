import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { comboLabel, KeyCombo } from '../../components/KeyCombo';
import {
  ADD_A_KEY,
  captureShortcut,
} from '../../services/shortcut/shortcutCapture';
import { listenShortcutBound } from '../../services/shortcut/bindingEvents';
import { subscribe } from '../../services/settingsWindow';

interface ShortcutRecorderProps {
  defaultValue: string;
  onChange: (combo: string) => void;
  value: string;
}

const SPOKEN: Record<string, string> = { Alt: 'Option', Ctrl: 'Control', Meta: 'Command' };

/** "Ctrl + Alt + Space" → "Control Option Space" for VoiceOver. */
export function spokenShortcut(combo: string): string {
  return combo.split('+').map((part) => part.trim()).filter(Boolean)
    .map((part) => SPOKEN[part] ?? part).join(' ');
}

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
  /** Last combo confirmed registered; the revert target (not the last attempt). */
  const confirmedRef = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const clearPending = () => {
    pendingRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  useEffect(() => subscribe(() => listenShortcutBound(({ active, ok, shortcut }) => {
    // Track what the OS holds from every result, even superseded ones, so a
    // late ok for A still makes A the revert target when B is refused.
    if (ok) confirmedRef.current = shortcut;
    else if (active !== undefined && active !== null) confirmedRef.current = active;
    const pending = pendingRef.current?.combo === shortcut ? pendingRef.current
      : lateRef.current?.combo === shortcut ? lateRef.current : null;
    if (!pending) return;
    clearPending();
    lateRef.current = null;
    if (!ok) onChangeRef.current(confirmedRef.current); // never keep a refused combo
    setStatus(ok
      ? { text: `Shortcut set to ${comboLabel(shortcut)}.`, tone: 'ok' }
      : { text: `Couldn't set ${comboLabel(shortcut)}. Previous shortcut kept.`, tone: 'error' });
  })), []);

  useEffect(() => clearPending, []);

  /** Save a combo and announce success only once registration confirms it. */
  const apply = (combo: string, okText: string) => {
    const changed = combo !== value;
    clearPending();
    onChange(combo);
    if (!changed || !isTauri()) {
      stop({ text: okText, tone: 'ok' });
      return;
    }
    lateRef.current = null;
    pendingRef.current = { combo };
    timerRef.current = setTimeout(() => {
      if (pendingRef.current?.combo !== combo) return;
      lateRef.current = pendingRef.current;
      clearPending();
      setStatus({ text: `Couldn't confirm ${comboLabel(combo)} yet. Try it, or record it again.`, tone: 'error' });
    }, CONFIRM_TIMEOUT_MS);
    stop({ text: `Setting ${comboLabel(combo)}…`, tone: 'info' });
  };

  const start = () => {
    sawKeyRef.current = false;
    setPreview('');
    setRecording(true);
    setStatus({ text: 'Recording. Press a shortcut, Escape to cancel.', tone: 'info' });
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
      stop({ text: 'Recording canceled. Shortcut unchanged.', tone: 'info' });
      return; // let Tab move focus on
    }
    // Keep the keystroke away from the in-app shortcut listener while recording.
    event.preventDefault();
    event.stopPropagation();
    if (result.kind === 'cancel') {
      stop({ text: 'Recording canceled. Shortcut unchanged.', tone: 'info' });
    } else if (result.kind === 'modifier-only') {
      setPreview(result.preview);
    } else if (result.kind === 'invalid') {
      sawKeyRef.current = true;
      setPreview('');
      setStatus({ text: result.message, tone: 'error' });
    } else {
      apply(result.combo, `Shortcut set to ${comboLabel(result.combo)}.`);
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
      setStatus({ text: ADD_A_KEY, tone: 'error' });
    }
  };

  const reset = () => apply(defaultValue, `Shortcut reset to ${comboLabel(defaultValue)}.`);

  return (
    <span className="shortcut-recorder">
      <button
        aria-describedby="settings-shortcut-help settings-shortcut-status"
        aria-label={recording ? 'Dictation shortcut, recording' : `Dictation shortcut, ${spokenShortcut(value)}`}
        aria-pressed={recording}
        className="shortcut-recorder__field"
        data-recording={recording || undefined}
        id="settings-shortcut"
        onBlur={() => recording && stop({ text: 'Recording canceled. Shortcut unchanged.', tone: 'info' })}
        onClick={() => (recording ? undefined : start())}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        type="button"
      >
        {recording
          ? <span className="shortcut-recorder__prompt">{preview ? `${comboLabel(preview)} …` : 'Press shortcut…'}</span>
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

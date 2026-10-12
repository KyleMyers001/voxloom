import { useRef, useState, type KeyboardEvent } from 'react';
import { comboLabel, KeyCombo } from '../../components/KeyCombo';
import {
  ADD_A_KEY,
  captureShortcut,
} from '../../services/shortcut/shortcutCapture';

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
      onChange(result.combo);
      stop({ text: `Shortcut set to ${comboLabel(result.combo)}.`, tone: 'ok' });
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

  const reset = () => {
    onChange(defaultValue);
    stop({ text: `Shortcut reset to ${comboLabel(defaultValue)}.`, tone: 'ok' });
  };

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
        role={status?.tone === 'error' ? 'alert' : 'status'}
      >
        {status?.text}
      </span>
    </span>
  );
}

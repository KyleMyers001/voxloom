import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { comboLabel, isMacPlatform, Kbd, KeyCombo, spokenCombo } from '../../components/KeyCombo';
import { captureShortcut } from '../../services/shortcut/shortcutCapture';
import { isLoneKey, isLoneModifier, loneKeyCap, spokenLoneKey } from '../../services/shortcut/loneKey';
import { IDLE, keyUp, modifierDown, otherDown, type LoneTracker } from '../../services/shortcut/loneKeyCapture';
import { getActiveShortcut, useShortcutActive } from '../../services/shortcut/activeShortcut';
import { emitShortcutRetry } from '../../services/shortcut/bindingEvents';
import { beginRecordingSuspend } from '../../services/shortcut/recordingSuspend';
import {
  attachRecorder, beginPending, cancelPending, setRecorderStatus, useRecorderStatus, type Status,
} from './recorderStore';
import {
  addAKey, CANCELED, CARD_CANCEL, CARD_CHANGE, CARD_DEFAULT_PILL, CARD_LABEL, CARD_PROMPT, CARD_RECORDING_HELP,
  CARD_RECORDING_LABEL, cardInUseText, cardNoneActiveText, holdHint, invalidText, NOT_ACTIVE, pendingText, PROMPT,
  RECORDING, resetLinkText, resetText, savedText, successText,
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
  /** "card": guided setup step 2 (BUS-219, Option A). Settings keeps the inline field. */
  variant?: 'card' | 'inline';
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
  variant = 'inline',
}: ShortcutRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [preview, setPreview] = useState('');
  const status = useRecorderStatus();
  const setStatus = setRecorderStatus;
  const active = useShortcutActive();
  const sawKeyRef = useRef(false);
  const loneRef = useRef<LoneTracker>(IDLE);
  const fieldRef = useRef<HTMLButtonElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const card = variant === 'card';
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
  const wasRecording = useRef(false);
  useLayoutEffect(() => {
    if (!card || recording === wasRecording.current) return;
    wasRecording.current = recording;
    // Recording: the dashed placeholder is the recorder (blur cancels), so it
    // takes focus. Done: Change returns unless focus moved on (Tab, a click).
    if (recording) fieldRef.current?.focus();
    else if (!document.activeElement || document.activeElement === document.body) changeRef.current?.focus();
  }, [card, recording]);

  /** Save a combo and announce success only once registration confirms it. */
  const apply = (combo: string, okText: string) => {
    const changed = combo !== value;
    cancelPending();
    if (!changed && isTauri() && getActiveShortcut() === null) {
      // Saved but not active (a refused launch keeps it): the value can't
      // change, so ask main to try binding it again.
      beginPending(combo);
      stop({ text: pendingText(combo), tone: 'info', kind: 'pending', combo });
      emitShortcutRetry(combo);
      return;
    }
    if (!changed || !isTauri()) {
      onChange(combo);
      stop({ text: okText, tone: 'ok', kind: 'saved', combo });
      return;
    }
    beginPending(combo);
    // "Setting…" first, then save: a result that lands during the save must
    // replace "Setting…", never be overwritten by it.
    stop({ text: pendingText(combo), tone: 'info', kind: 'pending', combo });
    onChange(combo);
  };

  const start = () => {
    sawKeyRef.current = false;
    loneRef.current = IDLE;
    setPreview('');
    setRecording(true);
    fieldRef.current?.focus();
    setStatus({ text: RECORDING, tone: 'info', kind: 'recording' });
  };

  const stop = (next: Status) => {
    setRecording(false);
    setPreview('');
    setStatus(next);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const result = captureShortcut(event);
    if (result.kind === 'cancel' && result.reason === 'tab') {
      stop({ text: CANCELED, tone: 'info', kind: 'canceled' });
      return; // let Tab move focus on
    }
    // Keep the keystroke from app shortcuts and the dialog's Esc-to-close.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (result.kind === 'cancel') {
      stop({ text: CANCELED, tone: 'info', kind: 'canceled' });
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
      setStatus({ text: invalidText(result.invalid), tone: 'error', kind: 'invalid' });
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
      setStatus({ text: invalidText(invalid), tone: 'error', kind: 'invalid' });
      return;
    }
    if (preview && !anyModifier) {
      // Released with only modifiers held, in a chord or one we can't bind.
      loneRef.current = IDLE;
      setPreview('');
      setStatus({ text: addAKey(), tone: 'error', kind: 'invalid' });
    }
  };

  handlersRef.current = { down: onKeyDown, up: onKeyUp };

  const reset = () => apply(defaultValue, resetText(defaultValue));

  if (card) {
    // A-none: show the keys that failed, though settings keep the previous
    // shortcut for the next launch (recorderStore restores it).
    const shown = !recording && status?.kind === 'none-active' && status.combo ? status.combo : value;
    const isDefault = shown === defaultValue;
    const message = cardMessage(status, recording, defaultValue);
    const error = message?.tone === 'error';
    const cardHelpId = `${id}-help`;
    const messageId = `${id}-status`;
    // Described by the help (not live). An error after recording is added, like
    // the inline field's errorId; while recording the live line announces it.
    const cancel = () => recording && stop({ text: CANCELED, tone: 'info', kind: 'canceled' });
    return (
      <div
        aria-labelledby={`${id}-label`}
        className="shortcut-card"
        data-state={recording ? 'recording' : error ? 'error' : 'idle'}
        role="group"
      >
        <div className="shortcut-card__label" id={`${id}-label`}>
          {recording ? CARD_RECORDING_LABEL : <>{CARD_LABEL}{isDefault && <> <span className="shortcut-card__pill">{CARD_DEFAULT_PILL}</span></>}</>}
        </div>
        <div className="shortcut-card__row">
          {recording ? <>
            <button
              aria-describedby={cardHelpId}
              aria-invalid={error || undefined}
              aria-label={recorderName(false, true, value, active)}
              aria-pressed="true"
              className="shortcut-card__recorder"
              data-recording
              id={id}
              key="recorder"
              onBlur={cancel}
              ref={fieldRef}
              type="button"
            >
              <span aria-hidden="true" className="shortcut-card__dot" />
              {preview ? `${comboLabel(preview)} …` : CARD_PROMPT}
            </button>
            {/* Pointer affordance: pressing it blurs the recorder (the same cancel). WebKit may not move focus on click, so it cancels too. */}
            <button className="btn shortcut-card__cancel" key="cancel" onClick={cancel} type="button">{CARD_CANCEL}</button>
          </> : <>
            <CardKeys active={active} value={shown} />
            <button
              aria-describedby={error ? `${cardHelpId} ${messageId}` : cardHelpId}
              aria-invalid={error || undefined}
              className="btn shortcut-card__change"
              key="change"
              onClick={start}
              ref={changeRef}
              type="button"
            >
              <PencilIcon />{CARD_CHANGE}
            </button>
          </>}
        </div>
        <div className="shortcut-card__foot">
          <div className="shortcut-card__slot">
            {/* A message takes the help's place on screen; hidden, it still describes the button. */}
            <p className="shortcut-card__help" hidden={Boolean(message)} id={cardHelpId}>{recording ? CARD_RECORDING_HELP : holdHint(shown)}</p>
            <p aria-live="polite" className="shortcut-card__message" data-tone={message?.tone} id={messageId} role="status">
              {message?.tone === 'ok' && <span aria-hidden="true">✓</span>}
              {message?.tone === 'error' && !recording && <span aria-hidden="true">!</span>}
              {message?.text}
            </p>
          </div>
          {!recording && !isDefault && <button className="shortcut-card__link" onClick={reset} type="button">{resetLinkText(defaultValue)}</button>}
        </div>
      </div>
    );
  }

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
        onBlur={() => recording && stop({ text: CANCELED, tone: 'info', kind: 'canceled' })}
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

/** What just happened, shown in the help's place; null keeps the help/hint. */
function cardMessage(status: Status, recording: boolean, defaultValue: string): { text: string; tone?: 'error' | 'ok' } | null {
  if (recording) return status?.kind === 'invalid' ? { text: status.text, tone: 'error' } : null;
  if (!status?.combo) return null;
  switch (status.kind) {
    case 'saved': return { text: savedText(status.combo), tone: 'ok' };
    case 'in-use': return { text: cardInUseText(status.combo, status.kept ?? status.combo), tone: 'error' };
    // A lone key keeps Settings' reason (Accessibility, or macOS only).
    case 'none-active': return isLoneKey(status.combo)
      ? { text: status.text, tone: 'error' }
      : { text: cardNoneActiveText(status.combo, status.combo !== defaultValue), tone: 'error' };
    case 'lone-refused': case 'timeout': return { text: status.text, tone: 'error' };
    case 'pending': return { text: status.text };
    default: return null;
  }
}

/** The shortcut once: caps, and for a lone key one cap plus its name ("⌥ Right Option"). */
function CardKeys({ active, value }: { active: boolean; value: string }) {
  const cap = loneKeyCap(value, isMacPlatform());
  const name = spokenLoneKey(value, isMacPlatform());
  return (
    <span className="shortcut-card__keys" data-inactive={!active || undefined}>
      {cap && name ? <>
        <span className="key-combo">
          <span aria-hidden="true" className="key-combo__caps"><Kbd>{cap}</Kbd></span>
          <span className="sr-only">{name}{active ? '' : `, ${NOT_ACTIVE}`}</span>
        </span>
        {name !== cap && <span aria-hidden="true" className="shortcut-card__keyname">{name}</span>}
      </> : <>
        <KeyCombo combo={value} />
        {!active && <span className="sr-only">, {NOT_ACTIVE}</span>}
      </>}
    </span>
  );
}

function PencilIcon() {
  return (
    <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 16 16">
      <path d="M11.5 2.5l2 2L6 12l-3 1 1-3z" /><path d="M10 4l2 2" />
    </svg>
  );
}

import { useState } from 'react';
import { useApp } from '../../app/AppContext';
import { Dialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { KeyCombo } from '../../components/KeyCombo';
import { isTauriEnv } from '../../services/capture/captureService';
import { useCaptureState } from '../../services/capture/useCaptureState';
import { MicStep } from './MicStep';
import { StepDots } from './StepDots';

interface OnboardingProps {
  onClose: () => void;
  opener?: HTMLElement | null;
}

/** Set-up sheet (SPEC § Onboarding; mocks onboarding-*). Simulate buttons are DEV-only. */
export function Onboarding({ onClose, opener }: OnboardingProps) {
  const { settings, setup, state } = useApp();
  const [error, setError] = useState('');
  const onboarding = state.onboarding;
  const update = setup.update;
  const capture = useCaptureState();
  const isNative = isTauriEnv();
  // In a browser context native capture is unavailable; allow Next without permission.
  const micAuthorized = !isNative || capture.permissionStatus === 'authorized';
  const shortcut = state.settings.shortcut;

  function next() {
    setError('');
    if (onboarding.step === 1 && !micAuthorized) {
      setError('Enable microphone access to continue, or choose Skip.');
      return;
    }
    if (onboarding.step === 2) {
      if (!shortcut.trim()) {
        setError('Enter a shortcut.');
        return;
      }
      if (!isNative && shortcut.toLowerCase() === 'ctrl + space') {
        update({ shortcutCollision: true });
        setError('“Ctrl + Space” is already in use (simulated). Choose another combo; your previous one is kept.');
        return;
      }
    }
    update({ shortcutCollision: false, step: (onboarding.step + 1) as 2 | 3 });
  }

  function finish() {
    if (!onboarding.holdTested || !onboarding.tapTested) {
      setError('Complete both practice tests, or choose Skip.');
      return;
    }
    update({ complete: true });
    onClose();
  }

  const simulate = (label: string, patch: Parameters<typeof update>[0]) => import.meta.env.DEV && (
    <button className="btn" onClick={() => update(patch)} type="button">{label}</button>
  );

  return (
    <Dialog label="Set up Voxloom" onClose={onClose} opener={opener}>
      <div className="sheet ob">
        <h2>Set up Voxloom</h2>
        <StepDots step={onboarding.step} />

        {onboarding.step === 1 && <MicStep capture={capture} isNative={isNative} />}

        {onboarding.step === 2 && (
          <section className="onboarding-step">
            <h3>Choose your shortcut</h3>
            <p>{isNative
              ? 'Desktop gestures use a global shortcut. Registration problems are shown in Settings.'
              : 'Browser prototype gestures work only while this tab is focused.'}</p>
            {shortcut.trim() && <div className="bigkeys"><KeyCombo combo={shortcut.replace(/\s*\+\s*/g, '+')} /></div>}
            <label className="field">
              {isNative ? 'Preferred global shortcut' : 'Preferred app-local shortcut'}
              <input
                aria-invalid={onboarding.shortcutCollision || undefined}
                onChange={(event) => settings.update({ key: 'shortcut', value: event.target.value })}
                value={shortcut}
              />
            </label>
          </section>
        )}

        {onboarding.step === 3 && (
          <section className="onboarding-step">
            <h3>Quick test</h3>
            <p>
              Hold and release the shortcut, then double-tap to latch and press once more to finish.
              This tests the gesture, not transcription.
            </p>
            <label className="field">Gesture feedback (not a speech transcript)
              <textarea placeholder="Gesture feedback appears here." readOnly value={onboarding.recognizedText} />
            </label>
            <div className="frow">
              <span>
                {onboarding.holdTested && <Icon name="check" size={14} />}
                Press-and-hold · {onboarding.holdTested ? 'recognized' : 'not tested'}
              </span>
              {simulate('Simulate hold', { holdTested: true, recognizedText: 'Simulated hold gesture detected.' })}
            </div>
            <div className="frow">
              <span>
                {onboarding.tapTested && <Icon name="check" size={14} />}
                Rapid double-tap · {onboarding.tapTested ? 'recognized' : 'not tested'}
              </span>
              {simulate('Simulate double-tap', { recognizedText: 'Simulated double-tap gesture detected.', tapTested: true })}
            </div>
          </section>
        )}

        {error && <p className="form-error ferr" role="alert"><Icon name="warn" size={14} />{error}</p>}

        <div className="sheet-acts">
          <button className="btn ghost" onClick={() => { update({ complete: true }); onClose(); }} type="button">
            Skip
          </button>
          <span className="sp" />
          {onboarding.step > 1 && (
            <button className="btn" onClick={() => update({ step: (onboarding.step - 1) as 1 | 2 })} type="button">
              Back
            </button>
          )}
          {onboarding.step < 3
            ? <button className="btn primary" onClick={next} type="button">Next</button>
            : <button className="btn primary" onClick={finish} type="button">Finish</button>}
        </div>
      </div>
    </Dialog>
  );
}

import { useState } from "react";
import { useApp } from "../../app/AppContext";
import { Dialog } from "../../components/Dialog";

interface OnboardingProps {
  onClose: () => void;
  opener?: HTMLElement | null;
}

export function Onboarding({ onClose, opener }: OnboardingProps) {
  const { settings, setup, state } = useApp();
  const [error, setError] = useState("");
  const onboarding = state.onboarding;
  const update = setup.update;

  function next() {
    setError("");
    if (onboarding.step === 1 && !onboarding.microphoneGranted) {
      setError("Enable the mock microphone or choose Skip.");
      return;
    }
    if (onboarding.step === 2) {
      if (!state.settings.shortcut.trim()) {
        setError("Enter a shortcut.");
        return;
      }
      if (state.settings.shortcut.toLowerCase() === "ctrl + space") {
        update({ shortcutCollision: true });
        setError("Ctrl + Space has a simulated collision.");
        return;
      }
    }
    update({ shortcutCollision: false, step: onboarding.step + 1 as 2 | 3 });
  }

  function finish() {
    if (!onboarding.holdTested || !onboarding.tapTested) {
      setError("Complete both practice tests, or choose Skip.");
      return;
    }
    update({ complete: true });
    onClose();
  }

  return (
    <Dialog label="Set up Voxloom" onClose={onClose} opener={opener}>
      <h2>Set up Voxloom</h2>
      <div className="onboarding-progress">
        <span>Step {onboarding.step} of 3</span>
        <progress max="3" value={onboarding.step} />
      </div>
      {onboarding.step === 1 && (
        <section className="onboarding-step">
          <h3>Private by default</h3>
          <p>No OS permission is requested. This control is a simulation.</p>
          <div className="onboarding-status">
            <span>{onboarding.permissionDenied ? "Mock permission denied" :
              onboarding.microphoneGranted ? "Mock microphone enabled" :
                "Mock microphone not enabled"}</span>
            <button className="btn" onClick={() => update({
              microphoneGranted: true,
              permissionDenied: false,
            })}>Enable mock microphone</button>
          </div>
        </section>
      )}
      {onboarding.step === 2 && (
        <section className="onboarding-step">
          <h3>Choose your shortcut</h3>
          <p>Gestures work only while this app is focused.</p>
          <label className="field">Preferred app-local shortcut
            <input onChange={(event) => settings.update({
              key: "shortcut",
              value: event.target.value,
            })} value={state.settings.shortcut} />
          </label>
        </section>
      )}
      {onboarding.step === 3 && (
        <section className="onboarding-step">
          <h3>Quick test</h3>
          <p>
            Hold and release the configured shortcut, then rapidly double-tap
            to latch and activate it once more to finish.
          </p>
          <label className="field">Recognized fixture text
            <textarea readOnly value={onboarding.recognizedText}
              placeholder="Practice output appears here." />
          </label>
          <div className="onboarding-test">
            <span>Press-and-hold · {onboarding.holdTested ?
              "recognized" : "not tested"}</span>
            {import.meta.env.DEV && <button className="btn" onClick={() =>
              update({
              holdTested: true,
              recognizedText: "Hold: preserve the TypeScript identifier.",
            })}>Test hold</button>}
          </div>
          <div className="onboarding-test">
            <span>Rapid double-tap · {onboarding.tapTested ?
              "recognized" : "not tested"}</span>
            {import.meta.env.DEV && <button className="btn" onClick={() =>
              update({
              recognizedText: "Double-tap: keep --dry-run enabled.",
              tapTested: true,
            })}>Test double-tap</button>}
          </div>
        </section>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="onboarding-actions">
        <button className="btn skip" onClick={() => {
          update({ complete: true });
          onClose();
        }}>Skip</button>
        {onboarding.step > 1 && <button className="btn" onClick={() =>
          update({ step: onboarding.step - 1 as 1 | 2 })}>Back</button>}
        {onboarding.step < 3 && <button className="btn accent"
          onClick={next}>Next</button>}
        {onboarding.step === 3 && <button className="btn accent"
          onClick={finish}>Finish</button>}
      </div>
    </Dialog>
  );
}

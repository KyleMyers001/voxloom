import { useState } from "react";
import { useApp } from "../../app/AppContext";
import { Dialog } from "../../components/Dialog";
import { isTauriEnv } from "../../services/capture/captureService";
import { useCaptureState } from
  "../../services/capture/useCaptureState";

interface OnboardingProps {
  onClose: () => void;
  opener?: HTMLElement | null;
}

export function Onboarding({ onClose, opener }: OnboardingProps) {
  const { settings, setup, state } = useApp();
  const [error, setError] = useState("");
  const onboarding = state.onboarding;
  const update = setup.update;

  const {
    captureState,
    permissionStatus,
    requestMicPermission,
    runMicTest,
    stopMicTest,
  } = useCaptureState();

  const isNative = isTauriEnv();
  // In a browser context native capture is unavailable;
  // allow Next without blocking on permission.
  const micAuthorized =
    !isNative || permissionStatus === "authorized";
  const micTesting = captureState.kind === "test-running";
  const micTestDone = captureState.kind === "test-complete";
  const micError =
    captureState.kind === "error" ? captureState.message : null;

  function next() {
    setError("");
    if (onboarding.step === 1 && !micAuthorized) {
      setError(
        "Enable microphone access to continue, or choose Skip.",
      );
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
    update({
      shortcutCollision: false,
      step: (onboarding.step + 1) as 2 | 3,
    });
  }

  function finish() {
    if (!onboarding.holdTested || !onboarding.tapTested) {
      setError("Complete both practice tests, or choose Skip.");
      return;
    }
    update({ complete: true });
    onClose();
  }

  function handleTestMic() {
    if (micTesting) {
      stopMicTest();
    } else {
      void runMicTest();
    }
  }

  function permissionLabel(): string {
    if (!isNative) {
      return "Native capture unavailable in this environment";
    }
    switch (permissionStatus) {
      case "authorized":
        return "Microphone access granted";
      case "denied":
        return "Microphone access denied \u2014 enable in System Settings";
      case "restricted":
        return "Microphone access restricted by system policy";
      case "not-determined":
        return "Microphone access not yet granted";
      default:
        return "Checking microphone permission\u2026";
    }
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
          <h3>Microphone access</h3>
          <p>
            Voxloom captures audio locally.
            No audio leaves your device.
          </p>
          <div className="onboarding-status">
            <span>{permissionLabel()}</span>
            {isNative && permissionStatus !== "authorized" && (
              <button className="btn" onClick={requestMicPermission}>
                Enable Microphone
              </button>
            )}
          </div>
          {isNative && permissionStatus === "authorized" && (
            <div className="onboarding-test">
              <span>
                {micTestDone
                  && captureState.kind === "test-complete"
                  ? captureState.metadata.detected_activity
                    ? "Audio activity detected \u2014 mic is working"
                    : "No audio activity detected \u2014 check your mic"
                  : micTesting
                    ? "Listening\u2026 (10\u202fs auto-stop)"
                    : "Test your microphone"}
              </span>
              <button className="btn" onClick={handleTestMic}>
                {micTesting ? "Stop test" : "Test Microphone"}
              </button>
            </div>
          )}
          {micError && (
            <p className="form-error" role="alert">{micError}</p>
          )}
          {isNative && permissionStatus === "denied" && (
            <p className="empty-note">
              Open System Settings &rsaquo;{" "}
              Privacy &amp; Security &rsaquo; Microphone and enable Voxloom.
            </p>
          )}
        </section>
      )}

      {onboarding.step === 2 && (
        <section className="onboarding-step">
          <h3>Choose your shortcut</h3>
          <p>Gestures work only while this app is focused.</p>
          <label className="field">Preferred app-local shortcut
            <input
              onChange={(event) => settings.update({
                key: "shortcut",
                value: event.target.value,
              })}
              value={state.settings.shortcut}
            />
          </label>
        </section>
      )}

      {onboarding.step === 3 && (
        <section className="onboarding-step">
          <h3>Quick test</h3>
          <p>
            Hold and release the configured shortcut, then rapidly
            double-tap to latch and activate it once more to finish.
          </p>
          <label className="field">Recognized fixture text
            <textarea
              placeholder="Practice output appears here."
              readOnly
              value={onboarding.recognizedText}
            />
          </label>
          <div className="onboarding-test">
            <span>
              Press-and-hold &middot;{" "}
              {onboarding.holdTested ? "recognized" : "not tested"}
            </span>
            {import.meta.env.DEV && (
              <button
                className="btn"
                onClick={() => update({
                  holdTested: true,
                  recognizedText:
                    "Hold: preserve the TypeScript identifier.",
                })}
              >
                Test hold
              </button>
            )}
          </div>
          <div className="onboarding-test">
            <span>
              Rapid double-tap &middot;{" "}
              {onboarding.tapTested ? "recognized" : "not tested"}
            </span>
            {import.meta.env.DEV && (
              <button
                className="btn"
                onClick={() => update({
                  recognizedText:
                    "Double-tap: keep --dry-run enabled.",
                  tapTested: true,
                })}
              >
                Test double-tap
              </button>
            )}
          </div>
        </section>
      )}

      {error && (
        <p className="form-error" role="alert">{error}</p>
      )}

      <div className="onboarding-actions">
        <button
          className="btn skip"
          onClick={() => {
            update({ complete: true });
            onClose();
          }}
        >
          Skip
        </button>
        {onboarding.step > 1 && (
          <button
            className="btn"
            onClick={() =>
              update({ step: (onboarding.step - 1) as 1 | 2 })
            }
          >
            Back
          </button>
        )}
        {onboarding.step < 3 && (
          <button className="btn accent" onClick={next}>
            Next
          </button>
        )}
        {onboarding.step === 3 && (
          <button className="btn accent" onClick={finish}>
            Finish
          </button>
        )}
      </div>
    </Dialog>
  );
}

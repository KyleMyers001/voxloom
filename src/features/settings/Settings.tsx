import { useApp } from "../../app/AppContext";
import {
  audioRetentions,
  parseChoice,
  transcriptRetentions,
  writingStyles,
} from "../../domain/settings";
import { isTauriEnv } from "../../services/capture/captureService";
import { SYSTEM_DEFAULT_DEVICE_ID } from
  "../../services/capture/types";
import { useCaptureState } from "../../services/capture/useCaptureState";
import type { Appearance } from "../../domain/types";

interface SettingsProps {
  onSetup: (opener: HTMLElement) => void;
}

const appearances: { label: string; value: Appearance }[] = [
  { label: "Follow system", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
  { label: "Sodium Rain", value: "sodium-rain" },
];

export function Settings({ onSetup }: SettingsProps) {
  const { settings, state } = useApp();

  const {
    captureReady,
    captureState,
    deviceListError,
    devices,
    devicesLoading,
    permissionStatus,
    prepareDeviceChange,
    refreshDevices,
    requestMicPermission,
    runMicTest,
    stopMicTest,
  } = useCaptureState();

  const isNative = isTauriEnv();
  const micAuthorized = permissionStatus === "authorized";
  const micTesting = captureState.kind === "test-running";
  const micSwitching = captureState.kind === "switching-device";
  const micTestDone = captureState.kind === "test-complete";
  const micError =
    captureState.kind === "error" ? captureState.message : null;

  const selectedDevice = state.settings.microphone;
  const selectedDescriptor = devices.find(
    (device) => device.id === selectedDevice,
  );
  const selectionUnavailable = selectedDevice !== SYSTEM_DEFAULT_DEVICE_ID
    && (!selectedDescriptor || !selectedDescriptor.available);

  async function handleDeviceChange(deviceId: string) {
    if (deviceId === selectedDevice) return;
    if (await prepareDeviceChange()) {
      settings.update({ key: "microphone", value: deviceId });
    }
  }

  function handleTestMic() {
    if (micTesting) {
      stopMicTest();
    } else {
      const device =
        selectedDevice !== SYSTEM_DEFAULT_DEVICE_ID
          ? selectedDevice
          : undefined;
      void runMicTest(device);
    }
  }

  return (
    <section aria-labelledby="settings-title">
      <div className="hero">
        <div>
          <h1 id="settings-title">Settings</h1>
          <p>Local, explicit, and recoverable by default.</p>
        </div>
      </div>

      <section className="card settings-section">
        <div className="card__head">
          <h2>Capture &amp; output</h2>
          <button
            className="btn"
            onClick={(event) => onSetup(event.currentTarget)}
          >
            Set up shortcuts
          </button>
        </div>
        <div className="form-grid">
          <label className="field">Shortcut · simulated
            <input
              onChange={(event) => settings.update({
                key: "shortcut",
                value: event.target.value,
              })}
              value={state.settings.shortcut}
            />
          </label>

          <label className="field">Microphone
            <select
              disabled={!isNative || !captureReady || micSwitching}
              onChange={(event) => {
                void handleDeviceChange(event.target.value);
              }}
              onFocus={() => { void refreshDevices(); }}
              value={state.settings.microphone}
            >
              <option value={SYSTEM_DEFAULT_DEVICE_ID}>System default</option>
              {selectionUnavailable && !selectedDescriptor && (
                <option disabled value={selectedDevice}>
                  Previously selected microphone (unavailable)
                </option>
              )}
              {devices.map((device) => (
                  <option
                    disabled={!device.available}
                    key={device.id}
                    value={device.id}
                  >
                    {device.label}
                    {device.available ? "" : " (unavailable)"}
                  </option>
                ))}
            </select>
            <button
              className="btn"
              disabled={
                !isNative
                || !captureReady
                || devicesLoading
                || micSwitching
              }
              onClick={() => { void refreshDevices(); }}
              type="button"
            >
              {devicesLoading ? "Refreshing…" : "Refresh microphones"}
            </button>
            {deviceListError && (
              <span className="form-error" role="alert">
                {deviceListError}
              </span>
            )}
          </label>

          <div className="field">
            <label>Microphone test</label>
            <div className="onboarding-status">
              <span>
                {!isNative
                  ? "Native microphone capture is unavailable here"
                  : !micAuthorized
                  ? permissionStatus === "denied"
                    ? "Permission denied — enable in System Settings"
                    : "Permission required"
                  : micSwitching
                    ? "Waiting for microphone to stop…"
                  : selectionUnavailable
                    ? "Selected microphone is unavailable"
                  : micTestDone
                    ? captureState.kind === "test-complete"
                      && captureState.metadata.detected_activity
                      ? "Audio activity detected"
                      : "No audio activity detected"
                    : micTesting
                      ? "Listening\u2026 (10 s auto-stop)"
                      : "Ready"}
              </span>
              {!isNative ? (
                <button className="btn" disabled>
                  Unavailable
                </button>
              ) : !micAuthorized ? (
                <button className="btn" onClick={requestMicPermission}>
                  Enable Microphone
                </button>
              ) : (
                <button
                  className="btn"
                  disabled={
                    !captureReady
                    || micSwitching
                    || selectionUnavailable
                  }
                  onClick={handleTestMic}
                >
                  {micTesting ? "Stop test" : "Test Microphone"}
                </button>
              )}
            </div>
            {micError && (
              <p className="form-error" role="alert">{micError}</p>
            )}
          </div>

          <label className="field">Language
            <select
              onChange={(event) => settings.update({
                key: "language",
                value: event.target.value,
              })}
              value={state.settings.language}
            >
              <option>English (US)</option>
              <option>English (UK)</option>
            </select>
          </label>

          <label className="field">Current style
            <select
              onChange={(event) => settings.update({
                key: "style",
                value: parseChoice(event.target.value, writingStyles),
              })}
              value={state.settings.style}
            >
              <option value="formal">Formal</option>
              <option value="casual">Casual</option>
              <option value="very-casual">Very Casual</option>
            </select>
          </label>

          <label className="field">
            Transcription model · simulated
            <select
              onChange={(event) => settings.update({
                key: "transcriptionModel",
                value: event.target.value,
              })}
              value={state.settings.transcriptionModel}
            >
              <option>Pine Voice Small · local</option>
              <option>Pine Voice Medium · unavailable</option>
            </select>
          </label>

          <label className="field">
            Language-processing model · simulated
            <select
              onChange={(event) => settings.update({
                key: "languageModel",
                value: event.target.value,
              })}
              value={state.settings.languageModel}
            >
              <option>Alder Text Small · local</option>
              <option>Alder Text Medium · unavailable</option>
            </select>
          </label>

          <label className="check">
            <input
              checked={state.settings.startAtLogin}
              onChange={(event) => settings.update({
                key: "startAtLogin",
                value: event.target.checked,
              })}
              type="checkbox"
            />
            Start at login · simulated
          </label>

          <label className="check">
            <input
              checked={state.settings.clipboardFallback}
              onChange={(event) => settings.update({
                key: "clipboardFallback",
                value: event.target.checked,
              })}
              type="checkbox"
            />
            Use clipboard if simulated direct insertion fails
          </label>

          <div className="field">
            <label>Recording indicator</label>
            <p className="empty-note">
              Fixed bottom-center while listening or processing.
            </p>
          </div>
        </div>
      </section>

      <section className="card settings-section">
        <h2>Appearance</h2>
        <fieldset className="appearance-options">
          <legend>Theme</legend>
          {appearances.map(({ label, value }) => (
            <label className="appearance-option" key={value}>
              <input
                checked={state.settings.appearance === value}
                name="appearance"
                onChange={() => settings.update({
                  key: "appearance",
                  value,
                })}
                type="radio"
                value={value}
              />
              <span>{label}</span>
              <span
                aria-hidden="true"
                className="appearance-swatch"
                data-preview={value}
              >
                <i /><i />
              </span>
            </label>
          ))}
        </fieldset>
      </section>

      <section className="card settings-section">
        <h2>Retention &amp; privacy</h2>
        <div className="form-grid">
          <label className="field">Transcript retention
            <select
              onChange={(event) => settings.update({
                key: "transcriptRetention",
                value: parseChoice(
                  event.target.value,
                  transcriptRetentions,
                ),
              })}
              value={state.settings.transcriptRetention}
            >
              <option value="30-days">30 days</option>
              <option value="forever">Until deleted</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label className="field">Audio retention
            <select
              onChange={(event) => settings.update({
                key: "audioRetention",
                value: parseChoice(
                  event.target.value,
                  audioRetentions,
                ),
              })}
              value={state.settings.audioRetention}
            >
              <option value="off">Off · recommended</option>
              <option value="24-hours">24 hours</option>
              <option value="7-days">7 days</option>
            </select>
          </label>
        </div>
        <p className="empty-note">
          Audio is captured locally and not stored. No audio or transcript
          is sent to a remote service. Transcription and shortcut triggering
          remain simulated in this build.
        </p>
      </section>

      <section className="card settings-section">
        <h2>Error &amp; recovery patterns</h2>
        <div className="recovery-list">
          {[
            "Microphone denied \u00b7 Enable in System Settings > " +
              "Privacy & Security > Microphone.",
            "Shortcut collision \u00b7 Choose another app-local gesture.",
            "Model unavailable \u00b7 No download is performed.",
            "No audio activity detected \u00b7 No transcript is created.",
            "Insertion failed \u00b7 Clipboard result is reported " +
              "truthfully.",
            "Transcription failed \u00b7 Temporary recovery buffers " +
              "expire.",
          ].map((message) => (
            <p className="recovery-item" key={message}>{message}</p>
          ))}
        </div>
      </section>
    </section>
  );
}

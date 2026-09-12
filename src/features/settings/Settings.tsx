import { useApp } from "../../app/AppContext";
import type { Appearance, Settings as SettingsType } from
  "../../domain/types";

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
  const { dispatch, state } = useApp();
  const update = (
    key: keyof SettingsType,
    value: SettingsType[keyof SettingsType],
  ) => dispatch({ key, type: "set-setting", value });

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
          <button className="btn" onClick={(event) =>
            onSetup(event.currentTarget)}>Set up shortcuts</button>
        </div>
        <div className="form-grid">
          <label className="field">Shortcut · simulated
            <input
              onChange={(event) => update("shortcut", event.target.value)}
              value={state.settings.shortcut}
            />
          </label>
          <label className="field">Microphone · simulated
            <select
              onChange={(event) => update("microphone", event.target.value)}
              value={state.settings.microphone}
            >
              <option>System default · simulated</option>
              <option>Studio USB microphone · simulated</option>
            </select>
          </label>
          <label className="field">Language
            <select value={state.settings.language} onChange={(event) =>
              update("language", event.target.value)}>
              <option>English (US)</option>
              <option>English (UK)</option>
            </select>
          </label>
          <label className="field">Current style
            <select value={state.settings.style} onChange={(event) =>
              update("style", event.target.value)}>
              <option value="formal">Formal</option>
              <option value="casual">Casual</option>
              <option value="very-casual">Very Casual</option>
            </select>
          </label>
          <label className="field">Transcription model · simulated
            <select value={state.settings.transcriptionModel}
              onChange={(event) => update(
                "transcriptionModel", event.target.value)}>
              <option>Pine Voice Small · local</option>
              <option>Pine Voice Medium · unavailable</option>
            </select>
          </label>
          <label className="field">Language-processing model · simulated
            <select value={state.settings.languageModel}
              onChange={(event) => update(
                "languageModel", event.target.value)}>
              <option>Alder Text Small · local</option>
              <option>Alder Text Medium · unavailable</option>
            </select>
          </label>
          <label className="check">
            <input checked={state.settings.startAtLogin}
              onChange={(event) => update(
                "startAtLogin", event.target.checked)} type="checkbox" />
            Start at login · simulated
          </label>
          <label className="check">
            <input checked={state.settings.clipboardFallback}
              onChange={(event) => update(
                "clipboardFallback", event.target.checked)} type="checkbox" />
            Use clipboard if direct insertion fails
          </label>
        </div>
      </section>
      <section className="card settings-section">
        <h2>Appearance</h2>
        <fieldset className="appearance-options">
          <legend>Theme</legend>
          {appearances.map(({ label, value }) => (
            <label className="appearance-option" key={value}>
              <input checked={state.settings.appearance === value}
                name="appearance" onChange={() => update("appearance", value)}
                type="radio" value={value} />
              <span>{label}</span>
              <span aria-hidden="true" className="appearance-swatch"
                data-preview={value}><i /><i /></span>
            </label>
          ))}
        </fieldset>
      </section>
      <section className="card settings-section">
        <h2>Retention &amp; privacy</h2>
        <div className="form-grid">
          <label className="field">Transcript retention
            <select value={state.settings.transcriptRetention}
              onChange={(event) => update(
                "transcriptRetention", event.target.value)}>
              <option value="30-days">30 days</option>
              <option value="forever">Until deleted</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label className="field">Audio retention
            <select value={state.settings.audioRetention}
              onChange={(event) => update(
                "audioRetention", event.target.value)}>
              <option value="off">Off · recommended</option>
              <option value="24-hours">24 hours</option>
              <option value="7-days">7 days</option>
            </select>
          </label>
        </div>
        <p className="empty-note">
          This prototype captures no audio, requests no permissions, and sends
          nothing to a remote service. All session data resets on reload.
        </p>
      </section>
      <section className="card settings-section">
        <h2>Error &amp; recovery patterns</h2>
        <div className="recovery-list">
          {[
            "Microphone denied · Recover through simulated setup.",
            "Shortcut collision · Choose another app-local gesture.",
            "Model unavailable · No download is performed.",
            "No speech detected · No transcript is created.",
            "Insertion failed · Clipboard result is reported truthfully.",
          ].map((message) => <p className="recovery-item" key={message}>
            {message}</p>)}
        </div>
      </section>
    </section>
  );
}

import { useApp } from '../../app/AppContext';
import { initialSettings } from '../../domain/fixtures';
import { SegmentedControl } from '../../components/SegmentedControl';
import { Switch } from '../../components/Switch';
import type { WritingStyle } from '../../domain/types';
import { isTauriEnv } from '../../services/capture/captureService';
import { MicrophoneRows } from './MicrophoneRows';
import { ShortcutRecorder } from './ShortcutRecorder';
import { HELP as SHORTCUT_HELP } from './shortcutCopy';

const styles: { value: WritingStyle; label: string }[] = [
  { value: 'formal', label: 'Formal' },
  { value: 'casual', label: 'Casual' },
  { value: 'very-casual', label: 'Very Casual' },
];

/** Capture & Output tab (S1–S11). Browser-only rows are gated per CHECKLIST § Hidden in the native app. */
export function CaptureTab({ onSetup }: { onSetup: (opener: HTMLElement) => void }) {
  const { settings, state } = useApp();
  const isNative = isTauriEnv();
  const update = settings.update;
  return (
    <div className="settings-rows">
      <div className="frow">
        <span className="frow__label">
          <span id="settings-shortcut-label">Shortcut</span>
          <small className="frow__help" id="settings-shortcut-help">
            {SHORTCUT_HELP}
          </small>
        </span>
        <span className="frow__control">
          <ShortcutRecorder
            defaultValue={initialSettings.shortcut}
            onChange={(value) => update({ key: 'shortcut', value })}
            value={state.settings.shortcut}
          />
          <button aria-label="Set up shortcuts" className="btn" onClick={(event) => onSetup(event.currentTarget)} type="button">
            Set up shortcuts…
          </button>
        </span>
      </div>
      <MicrophoneRows />
      <div className="frow">
        <span className="frow__label">
          <label htmlFor="settings-language">Language</label>
          {isNative && <span className="tag">English-first</span>}
        </span>
        <select
          disabled={isNative}
          id="settings-language"
          onChange={(event) => update({ key: 'language', value: event.target.value })}
          value={isNative ? 'English (US)' : state.settings.language}
        >
          <option>English (US)</option>
          {!isNative && <option>English (UK)</option>}
        </select>
      </div>
      <div className="frow">
        <span className="frow__label">
          <span>Writing style</span>
          {isNative && <small className="frow__help">Cleanup not available yet</small>}
        </span>
        <SegmentedControl
          label={isNative ? 'Style preference · cleanup unavailable' : 'Current style'}
          onChange={(value) => update({ key: 'style', value })}
          options={styles}
          size="sm"
          value={state.settings.style}
        />
      </div>
      {!isNative && (
        <div className="frow">
          <span className="frow__label">
            <label htmlFor="settings-language-model">Language-processing model · simulated</label>
          </span>
          <select
            id="settings-language-model"
            onChange={(event) => update({ key: 'languageModel', value: event.target.value })}
            value={state.settings.languageModel}
          >
            <option>Alder Text Small · local</option>
            <option>Alder Text Medium · unavailable</option>
          </select>
        </div>
      )}
      <div className="frow">
        <span className="frow__label"><span>Use clipboard if direct insertion fails</span></span>
        <Switch
          checked={state.settings.clipboardFallback}
          hideLabel
          label="Use clipboard if direct insertion fails"
          onChange={(value) => update({ key: 'clipboardFallback', value })}
        />
      </div>
      <div className="frow">
        <span className="frow__label">
          <span>{isNative ? 'Start at login' : 'Start at login · simulated'}</span>
          {isNative && <span className="tag">Unavailable in desktop</span>}
        </span>
        <Switch
          checked={isNative ? false : state.settings.startAtLogin}
          disabled={isNative}
          hideLabel
          label={isNative ? 'Start at login · unavailable in desktop' : 'Start at login · simulated'}
          onChange={(value) => update({ key: 'startAtLogin', value })}
        />
      </div>
      <div className="frow">
        <span className="frow__label">
          <span>Recording indicator</span>
          <small className="frow__help">Fixed bottom-center while listening or transcribing.</small>
        </span>
        <span aria-hidden="true" className="mini-hud"><i /><i /><i /><i /><i /></span>
      </div>
    </div>
  );
}

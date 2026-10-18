import { Icon } from '../../components/Icon';
import { comboLabel } from '../../components/KeyCombo';
import { isTauriEnv } from '../../services/capture/captureService';

type Props = {
  settingsOpen: boolean;
  onSettings: () => void;
  onHelp: (opener: HTMLElement) => void;
};

/**
 * Window toolbar: Settings… ⌘, and the keyboard-shortcuts "?" button.
 * The standard macOS title bar stays (designer), so the app name is only drawn
 * in the browser preview; no overlay title bar or traffic-light inset.
 */
export function TitleBar({ settingsOpen, onSettings, onHelp }: Props) {
  return (
    <header className="titlebar">
      {!isTauriEnv() && <span className="titlebar__title">Voxloom</span>}
      <button
        aria-current={settingsOpen ? 'page' : undefined}
        aria-label="Settings"
        className="tb-settings"
        onClick={onSettings}
        title={`Settings… (${comboLabel('CommandOrControl+,')})`}
        type="button"
      >
        <Icon name="gear" size={14} />
        <span aria-hidden="true">Settings… {comboLabel('CommandOrControl+,')}</span>
      </button>
      <button
        aria-label="Open keyboard shortcuts"
        className="tb-help"
        onClick={(event) => onHelp(event.currentTarget)}
        title="Keyboard shortcuts (?)"
        type="button"
      >
        ?
      </button>
    </header>
  );
}

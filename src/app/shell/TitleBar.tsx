import { Icon } from '../../components/Icon';

type Props = {
  settingsOpen: boolean;
  onSettings: () => void;
  onHelp: (opener: HTMLElement) => void;
};

/** Window toolbar: Settings… ⌘, and the keyboard-shortcuts "?" button. */
export function TitleBar({ settingsOpen, onSettings, onHelp }: Props) {
  return (
    <header className="titlebar">
      <span className="titlebar__title">Voxloom</span>
      <button
        aria-current={settingsOpen ? 'page' : undefined}
        aria-label="Settings"
        className="tb-settings"
        onClick={onSettings}
        title="Settings… (⌘,)"
        type="button"
      >
        <Icon name="gear" size={14} />
        <span aria-hidden="true">Settings… ⌘,</span>
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

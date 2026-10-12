import { useEffect, useState } from 'react';
import { AppearanceTab } from './AppearanceTab';
import { CaptureTab } from './CaptureTab';
import { ModelsTab } from './ModelsTab';
import { PrivacyTab } from './PrivacyTab';
import { settingsTabs, SettingsTabs, type SettingsTab } from './SettingsTabs';

interface SettingsProps {
  onSetup: (opener: HTMLElement) => void;
  initialTab?: SettingsTab;
  /** In the native Settings window: name the window after the current tab. */
  onTabTitle?: (label: string) => void;
}

/**
 * Settings, laid out as the Console Settings window: toolbar tabs over one panel.
 * Rendered in-page for now; UI PR 6b moves it into its own Tauri window (⌘,).
 */
export function Settings({ onSetup, initialTab = 'capture', onTabTitle }: SettingsProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const { label, title } = settingsTabs.find((t) => t.value === tab)!;
  useEffect(() => { onTabTitle?.(label); }, [label, onTabTitle]);
  return (
    <section aria-labelledby="settings-title" className="settings-window">
      <header className="settings-window__bar">
        <h1 id="settings-title">Settings</h1>
        <SettingsTabs onChange={setTab} value={tab} />
      </header>
      <div
        aria-labelledby={`settings-tab-${tab}`}
        className="settings-panel"
        id={`settings-panel-${tab}`}
        role="tabpanel"
        tabIndex={0}
      >
        {/* BUS-41: the window title already names the tab; keep the heading for screen readers. */}
        <h2 className="sr-only">{title}</h2>
        {tab === 'capture' && <CaptureTab onSetup={onSetup} />}
        {tab === 'models' && <ModelsTab />}
        {tab === 'appearance' && <AppearanceTab />}
        {tab === 'privacy' && <PrivacyTab />}
      </div>
    </section>
  );
}

import { useEffect, useState } from 'react';
import type { CleanupModelStore } from '../../services/cleanup';
import { AppearanceTab } from './AppearanceTab';
import { CaptureTab } from './CaptureTab';
import { ModelsTab } from './ModelsTab';
import { PrivacyTab } from './PrivacyTab';
import { settingsTabs, SettingsTabs, type SettingsTab } from './SettingsTabs';

interface SettingsProps {
  cleanupModelStore?: CleanupModelStore;
  onSetup: (opener: HTMLElement) => void;
  initialTab?: SettingsTab;
  /** In the native Settings window: name the window after the current tab. */
  onTabTitle?: (label: string) => void;
}

/** Toolbar tabs shared by the browser preview and native Settings window. */
export function Settings({ cleanupModelStore, onSetup, initialTab = 'capture', onTabTitle }: SettingsProps) {
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
        <h2 className="sr-only">{title}</h2>
        {tab === 'capture' && <CaptureTab cleanupModelStore={cleanupModelStore} onSetup={onSetup} />}
        {tab === 'models' && <ModelsTab />}
        {tab === 'appearance' && <AppearanceTab />}
        {tab === 'privacy' && <PrivacyTab />}
      </div>
    </section>
  );
}

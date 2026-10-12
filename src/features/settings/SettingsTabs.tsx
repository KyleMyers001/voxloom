import { useRef, type KeyboardEvent } from 'react';
import { Icon, type IconName } from '../../components/Icon';

export type SettingsTab = 'capture' | 'models' | 'appearance' | 'privacy';

export const settingsTabs: { value: SettingsTab; label: string; title: string; icon: IconName }[] = [
  { value: 'capture', label: 'Capture', title: 'Capture & Output', icon: 'mic' },
  { value: 'models', label: 'Models', title: 'Speech-to-text models', icon: 'download' },
  { value: 'appearance', label: 'Appearance', title: 'Appearance', icon: 'gear' },
  { value: 'privacy', label: 'Privacy', title: 'Privacy & Recovery', icon: 'check' },
];

const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };

/** Settings toolbar: a tablist (arrows, Home, End) over the four tab panels. */
export function SettingsTabs({ value, onChange }: { value: SettingsTab; onChange: (tab: SettingsTab) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = settingsTabs.findIndex((tab) => tab.value === value);

  function onKeyDown(event: KeyboardEvent) {
    const n = settingsTabs.length;
    const next = event.key in step ? (current + step[event.key] + n) % n
      : event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    onChange(settingsTabs[next].value);
    refs.current[next]?.focus();
  }

  return (
    <div aria-label="Settings sections" className="settings-tabs" onKeyDown={onKeyDown} role="tablist">
      {settingsTabs.map((tab, index) => (
        <button
          aria-controls={`settings-panel-${tab.value}`}
          aria-selected={tab.value === value}
          className="settings-tab"
          id={`settings-tab-${tab.value}`}
          key={tab.value}
          onClick={() => onChange(tab.value)}
          ref={(el) => { refs.current[index] = el; }}
          role="tab"
          tabIndex={tab.value === value ? 0 : -1}
          type="button"
        >
          <Icon name={tab.icon} size={18} />
          <span>{tab.label}</span>
        </button>
      ))}
    </div>
  );
}

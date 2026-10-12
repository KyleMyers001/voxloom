import { useApp } from '../app/AppContext';
import { BootHydratePlaceholder } from '../app/shell/BootHydratePlaceholder';
import { useTheme } from '../app/useTheme';
import { Banner } from '../components/Banner';
import { Settings } from '../features/settings/Settings';
import { requestOnboarding } from '../services/settingsWindow';

/** Root of the native Settings window (settings.html). Main owns capture, shortcuts and history. */
export function SettingsWindowApp() {
  const { bootReady, state } = useApp();
  useTheme(state.settings.appearance);
  return (
    <main className="settings-window-root">
      {state.settingsError && <Banner tone="error">{state.settingsError}</Banner>}
      {bootReady
        ? <Settings onSetup={() => { void requestOnboarding(); }} />
        : <BootHydratePlaceholder title="Settings" />}
    </main>
  );
}

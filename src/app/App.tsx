import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Toast } from '../components/Toast';
import type { Screen } from '../domain/types';
import { Dictionary } from '../features/dictionary/Dictionary';
import { History } from '../features/history/History';
import { Home } from '../features/home/Home';
import { Onboarding } from '../features/onboarding/Onboarding';
import { Settings } from '../features/settings/Settings';
import { isTauriEnv } from '../services/capture/captureService';
import { listenOnboardingOpen, openSettingsWindow, subscribe } from '../services/settingsWindow';
import { useDogfoodCapture } from '../services/stt/useDogfoodCapture';
import { ResetSessionDialog, ShortcutsDialog } from './AppDialogs';
import { useApp } from './AppContext';
import { BootHydratePlaceholder } from './shell/BootHydratePlaceholder';
import { Sidebar } from './shell/Sidebar';
import { TitleBar } from './shell/TitleBar';
import { useAppKeys } from './useAppKeys';
import { useDevSession } from './useDevSession';
import { toGestureDogfoodBridge, useShortcutGestures } from './useShortcutGestures';
import { useTextSize, useTheme } from './useTheme';
import { useToastMessages } from './useToastMessages';

export function App() {
  const { bootReady, clipboard, dictation, dispatch, now, setup, state } = useApp();
  const [onboardingOpen, setOnboardingOpen] = useState(!state.onboarding.complete);
  const [shortcutOpen, setShortcutOpen] = useState(false);
  const modalOpener = useRef<HTMLElement | null>(null);
  useTheme(state.settings.appearance);
  useTextSize(state.settings.textSize);
  const { toast, toastTone, announce, announceError } = useToastMessages([
    state.historyError, state.settingsError, state.dictionaryError,
  ]);

  // Shared dogfood path: Home Start + global gesture (BUS-14).
  // Gesture start snapshots while the other app is still frontmost.
  const dogfood = useDogfoodCapture({
    clipboard,
    clipboardFallback: state.settings.clipboardFallback,
    modelId: state.settings.transcriptionModel,
    now,
    onHistoryRecord: (record) => dispatch({ record, type: 'append-record' }),
    onToast: announce,
    preferredDeviceId: state.settings.microphone,
    style: state.settings.style,
  });

  // Close onboarding when durable settings hydrate with complete=true.
  useEffect(() => {
    if (state.onboarding.complete) setOnboardingOpen(false);
  }, [state.onboarding.complete]);

  const onShortcutRevert = useCallback(
    (shortcut: string) => dispatch({ key: 'shortcut', now: now(), type: 'set-setting', value: shortcut }),
    [dispatch, now],
  );

  useShortcutGestures({
    dictation,
    dogfood: toGestureDogfoodBridge(dogfood),
    now,
    onboardingOpen,
    onShortcutError: announceError,
    onShortcutRevert,
    setup,
    shortcutOpen,
    state,
  });

  // Native: Settings is its own window (title bar, ⌥4, ⌘,); browser dev keeps it in-page.
  const native = isTauriEnv();
  const navigate = useCallback((screen: Screen) => {
    if (screen === 'settings' && native) void openSettingsWindow()
      .catch((error: unknown) => announceError(`Couldn't open Settings: ${String(error)}`));
    else dispatch({ screen, type: 'set-screen' });
  }, [announceError, dispatch, native]);
  const openHelp = useCallback((opener: HTMLElement) => {
    modalOpener.current = opener;
    setShortcutOpen(true);
  }, []);
  useAppKeys({ blocked: onboardingOpen || shortcutOpen, onHelp: openHelp, onNavigate: navigate });

  const dev = useDevSession(
    () => setOnboardingOpen(true),
    () => { modalOpener.current = null; },
  );

  const openSetup = useCallback((opener: HTMLElement | null) => {
    modalOpener.current = opener;
    setup.reopen();
    setOnboardingOpen(true);
  }, [setup]);
  // "Set up shortcuts…" in the Settings window opens onboarding here.
  useEffect(() => subscribe(() => listenOnboardingOpen(() => openSetup(null))), [openSetup]);

  const status = dogfood.phase === 'recording' ? 'Listening'
    : dogfood.phase === 'transcribing' ? 'Transcribing' : 'Ready';
  const gated = (title: string, screen: ReactNode) =>
    bootReady ? screen : <BootHydratePlaceholder title={title} />;

  return <>
    <div className="app" id="app-shell">
      <TitleBar
        onHelp={openHelp}
        onSettings={() => navigate('settings')}
        settingsOpen={!native && state.screen === 'settings'}
      />
      <Sidebar
        onNavigate={navigate}
        onReset={dev.requestReset}
        onScenario={dev.openScenario}
        screen={state.screen}
        shortcut={state.settings.shortcut}
        status={status}
      />
      <main className="main">
        {(state.screen === 'home' || (native && state.screen === 'settings')) && <Home dogfood={dogfood} onToast={announce} />}
        {state.screen === 'history' && gated('History', <History onToast={announce} />)}
        {state.screen === 'dictionary' && gated('Dictionary', <Dictionary />)}
        {!native && state.screen === 'settings' && gated('Settings', <Settings onSetup={openSetup} />)}
      </main>
    </div>
    {onboardingOpen && <Onboarding onClose={() => setOnboardingOpen(false)}
      opener={modalOpener.current} />}
    {shortcutOpen && <ShortcutsDialog onClose={() => setShortcutOpen(false)}
      opener={modalOpener.current} shortcut={state.settings.shortcut} />}
    {dev.resetPromptOpen && <ResetSessionDialog onClose={dev.closeResetPrompt}
      onReset={dev.performReset} opener={modalOpener.current} />}
    <Toast message={toast} tone={toastTone} />
  </>;
}

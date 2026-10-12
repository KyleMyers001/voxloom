import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../components/Dialog';
import { Toast } from '../components/Toast';
import { ScenarioPanel, type OnboardingScenario } from
  '../dev/ScenarioPanel';
import { initialOnboarding } from '../domain/fixtures';
import type { Screen } from '../domain/types';
import { Dictionary } from '../features/dictionary/Dictionary';
import { History } from '../features/history/History';
import { Home } from '../features/home/Home';
import { Onboarding } from '../features/onboarding/Onboarding';
import { Settings } from '../features/settings/Settings';
import { useDogfoodCapture } from '../services/stt/useDogfoodCapture';
import { useApp } from './AppContext';
import { hasOpenModal } from './modalState';
import {
  toGestureDogfoodBridge,
  useShortcutGestures,
} from './useShortcutGestures';
import { useTheme } from './useTheme';
import { AppTile } from '../components/AppTile';

const screens: { glyph: string; label: string; value: Screen }[] = [
  { glyph: '⌂', label: 'Home', value: 'home' },
  { glyph: '↶', label: 'History', value: 'history' },
  { glyph: 'Aa', label: 'Dictionary', value: 'dictionary' },
  { glyph: '⌘', label: 'Settings', value: 'settings' },
];


function BootHydratePlaceholder({ title }: { title: string }) {
  return (
    <section aria-busy="true" aria-labelledby="boot-hydrate-title">
      <div className="hero">
        <div>
          <h1 id="boot-hydrate-title">{title}</h1>
          <p>Loading saved data for this device…</p>
        </div>
      </div>
      <div className="card">
        <p className="empty-note" role="status">Loading…</p>
      </div>
    </section>
  );
}

export function App() {
  const {
    bootReady, clipboard, dictation, dispatch, dictionaryDurable, historyDurable, now, settings,
    settingsDurable, setup, state,
  } = useApp();
  const [onboardingOpen, setOnboardingOpen] = useState(
    !state.onboarding.complete,
  );
  const [shortcutOpen, setShortcutOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [resetPromptOpen, setResetPromptOpen] = useState(false);
  const modalOpener = useRef<HTMLElement | null>(null);
  useTheme(state.settings.appearance);

  function announce(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(''), 1_800);
  }

  // Shared dogfood path: Home Start + global gesture (BUS-14).
  // Gesture start snapshots while the other app is still frontmost.
  const dogfood = useDogfoodCapture({
    clipboard,
    clipboardFallback: state.settings.clipboardFallback,
    modelId: state.settings.transcriptionModel,
    now,
    onHistoryRecord: (record) => {
      dispatch({ record, type: 'append-record' });
    },
    onToast: announce,
    preferredDeviceId: state.settings.microphone,
    style: state.settings.style,
  });

  // Close onboarding when durable settings hydrate with complete=true.
  useEffect(() => {
    if (state.onboarding.complete) setOnboardingOpen(false);
  }, [state.onboarding.complete]);

  useEffect(() => {
    if (!state.historyError) return;
    setToast(state.historyError);
    const timer = window.setTimeout(() => setToast(''), 4_000);
    return () => window.clearTimeout(timer);
  }, [state.historyError]);

  useEffect(() => {
    if (!state.settingsError) return;
    setToast(state.settingsError);
    const timer = window.setTimeout(() => setToast(''), 4_000);
    return () => window.clearTimeout(timer);
  }, [state.settingsError]);

  useEffect(() => {
    if (!state.dictionaryError) return;
    setToast(state.dictionaryError);
    const timer = window.setTimeout(() => setToast(''), 4_000);
    return () => window.clearTimeout(timer);
  }, [state.dictionaryError]);

  useShortcutGestures({
    dictation,
    dogfood: toGestureDogfoodBridge(dogfood),
    now,
    onboardingOpen,
    onShortcutError: (message) => {
      setToast(message);
      window.setTimeout(() => setToast(''), 4_000);
    },
    setup,
    shortcutOpen,
    state,
  });

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (onboardingOpen || shortcutOpen || hasOpenModal()) return;
      const target = event.target as HTMLElement;
      if (event.key === '?' && !target.matches('input, select, textarea')) {
        modalOpener.current = target;
        setShortcutOpen(true);
      }
      if (event.altKey && /^[1-4]$/.test(event.key)) {
        dispatch({
          screen: screens[Number(event.key) - 1].value,
          type: 'set-screen',
        });
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [dispatch, onboardingOpen, shortcutOpen]);

  function openSetup(opener: HTMLElement) {
    modalOpener.current = opener;
    setup.reopen();
    setOnboardingOpen(true);
  }

  function performReset(wipeHistory: boolean) {
    modalOpener.current = null;
    setResetPromptOpen(false);
    dispatch({
      now: now(),
      persistDictionary: dictionaryDurable,
      persistHistory: historyDurable,
      persistSettings: settingsDurable,
      type: 'reset',
      wipeHistory,
    });
    setOnboardingOpen(true);
  }

  function requestResetSession() {
    if (historyDurable) {
      setResetPromptOpen(true);
      return;
    }
    performReset(false);
  }

  function openScenario(scenario: OnboardingScenario) {
    const collision = scenario === 'collision';
    setup.replace({
      ...initialOnboarding,
      microphoneGranted: collision,
      permissionDenied: scenario === 'permission-denied',
      shortcutCollision: collision,
      step: collision ? 2 : 1,
    });
    if (collision) settings.update({
      key: 'shortcut',
      value: 'Ctrl + Space',
    });
    setOnboardingOpen(true);
  }

  return <>
    <div className="app" id="app-shell">
      <header className="topbar">
        <div className="topbar__mark"><AppTile size="sm" />Voxloom</div>
        <button aria-label="Open keyboard shortcuts" className="icon-btn"
          onClick={(event) => {
            modalOpener.current = event.currentTarget;
            setShortcutOpen(true);
          }}>?</button>
      </header>
      <aside className="sidebar">
        <nav aria-label="Voxloom screens">
          {screens.map(({ glyph, label, value }) => <button
            aria-label={label}
            aria-current={state.screen === value ? 'page' : undefined}
            className="nav-button" key={value} onClick={() => dispatch({
              screen: value,
              type: 'set-screen',
            })}><span className="nav-glyph">{glyph}</span>{label}</button>)}
        </nav>
        {import.meta.env.DEV && <ScenarioPanel
          onOnboarding={openScenario}
          onReset={requestResetSession}
        />}
        <p className="review-note">
          Global hold/latch snapshots the frontmost app then runs Dictate
          (insert or Copy). Home Start may Copy when Voxloom is focused.
        </p>
      </aside>
      <main className="main">
        {state.screen === 'home' && (
          <Home dogfood={dogfood} onToast={announce} />
        )}
        {state.screen === 'history' && (
          bootReady
            ? <History onToast={announce} />
            : <BootHydratePlaceholder title="History" />
        )}
        {state.screen === 'dictionary' && (
          bootReady
            ? <Dictionary />
            : <BootHydratePlaceholder title="Dictionary" />
        )}
        {state.screen === 'settings' && (
          bootReady
            ? <Settings onSetup={openSetup} />
            : <BootHydratePlaceholder title="Settings" />
        )}
      </main>
    </div>
    {onboardingOpen && <Onboarding onClose={() => setOnboardingOpen(false)}
      opener={modalOpener.current} />}
    {shortcutOpen && <Dialog label="Keyboard shortcuts"
      onClose={() => setShortcutOpen(false)} opener={modalOpener.current}>
      <h2>Keyboard shortcuts</h2>
      <p>Hold or double-tap the configured shortcut (global in the desktop shell; app-focused in browser preview). Hold while Notes is focused to smoke Inserted; Home Start may Copy if Voxloom is focused.</p>
      <div className="overlay__row"><span>Configured gesture</span>
        <kbd>{state.settings.shortcut}</kbd></div>
      <div className="overlay__row"><span>Navigate screens</span>
        <kbd>Alt + 1…4</kbd></div>
    </Dialog>}
    {resetPromptOpen && <Dialog label="Reset session"
      onClose={() => setResetPromptOpen(false)}
      opener={modalOpener.current}>
      <h2>Reset session</h2>
      <p>
        Durable history is on. Choose whether to keep <code>history.json</code>
        or wipe it. Fixture seed data is never written without an explicit wipe.
      </p>
      <div className="overlay__actions">
        <button onClick={() => performReset(false)} type="button">
          Keep durable history
        </button>
        <button className="danger" onClick={() => performReset(true)}
          type="button">
          Wipe durable history
        </button>
        <button onClick={() => setResetPromptOpen(false)} type="button">
          Cancel
        </button>
      </div>
    </Dialog>}
    <Toast message={toast} />
  </>;
}

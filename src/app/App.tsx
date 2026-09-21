import { useEffect, useRef, useState } from "react";
import { Dialog } from "../components/Dialog";
import { Toast } from "../components/Toast";
import { Waveform } from "../components/Waveform";
import { ScenarioPanel, type OnboardingScenario } from
  "../dev/ScenarioPanel";
import { initialOnboarding } from "../domain/fixtures";
import type { Screen } from "../domain/types";
import { Dictionary } from "../features/dictionary/Dictionary";
import { History } from "../features/history/History";
import { Home } from "../features/home/Home";
import { Onboarding } from "../features/onboarding/Onboarding";
import { Settings } from "../features/settings/Settings";
import { useApp } from "./AppContext";
import { hasOpenModal } from "./modalState";
import { useShortcutGestures } from "./useShortcutGestures";
import { useTheme } from "./useTheme";

const screens: { glyph: string; label: string; value: Screen }[] = [
  { glyph: "⌂", label: "Home", value: "home" },
  { glyph: "↶", label: "History", value: "history" },
  { glyph: "Aa", label: "Dictionary", value: "dictionary" },
  { glyph: "⌘", label: "Settings", value: "settings" },
];

export function App() {
  const { dictation, dispatch, now, settings, setup, state } = useApp();
  const [onboardingOpen, setOnboardingOpen] = useState(
    !state.onboarding.complete,
  );
  const [shortcutOpen, setShortcutOpen] = useState(false);
  const [toast, setToast] = useState("");
  const modalOpener = useRef<HTMLElement | null>(null);
  useTheme(state.settings.appearance);
  useShortcutGestures({
    dictation,
    now,
    onboardingOpen,
    setup,
    shortcutOpen,
    state,
  });

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (onboardingOpen || shortcutOpen || hasOpenModal()) return;
      const target = event.target as HTMLElement;
      if (event.key === "?" && !target.matches("input, select, textarea")) {
        modalOpener.current = target;
        setShortcutOpen(true);
      }
      if (event.altKey && /^[1-4]$/.test(event.key)) {
        dispatch({
          screen: screens[Number(event.key) - 1].value,
          type: "set-screen",
        });
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [dispatch, onboardingOpen, shortcutOpen]);

  function announce(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 1_800);
  }

  function openSetup(opener: HTMLElement) {
    modalOpener.current = opener;
    setup.reopen();
    setOnboardingOpen(true);
  }

  function resetSession() {
    modalOpener.current = null;
    dispatch({ now: now(), type: "reset" });
    setOnboardingOpen(true);
  }

  function openScenario(scenario: OnboardingScenario) {
    const collision = scenario === "collision";
    setup.replace({
      ...initialOnboarding,
      microphoneGranted: collision,
      permissionDenied: scenario === "permission-denied",
      shortcutCollision: collision,
      step: collision ? 2 : 1,
    });
    if (collision) settings.update({
      key: "shortcut",
      value: "Ctrl + Space",
    });
    setOnboardingOpen(true);
  }

  return <>
    <div className="app" id="app-shell">
      <header className="topbar">
        <div className="topbar__mark">Voxloom</div>
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
            aria-current={state.screen === value ? "page" : undefined}
            className="nav-button" key={value} onClick={() => dispatch({
              screen: value,
              type: "set-screen",
            })}><span className="nav-glyph">{glyph}</span>{label}</button>)}
        </nav>
        {import.meta.env.DEV && <ScenarioPanel
          onOnboarding={openScenario}
          onReset={resetSession}
        />}
        <p className="review-note">
          Shortcut remains simulated. Dictate on Home uses Settings STT model → Copy.
        </p>
      </aside>
      <main className="main">
        {state.screen === "home" && <Home onToast={announce} />}
        {state.screen === "history" && <History onToast={announce} />}
        {state.screen === "dictionary" && <Dictionary />}
        {state.screen === "settings" && <Settings onSetup={openSetup} />}
      </main>
      <Waveform />
    </div>
    {onboardingOpen && <Onboarding onClose={() => setOnboardingOpen(false)}
      opener={modalOpener.current} />}
    {shortcutOpen && <Dialog label="Keyboard shortcuts"
      onClose={() => setShortcutOpen(false)} opener={modalOpener.current}>
      <h2>Keyboard shortcuts</h2>
      <p>Hold or double-tap works only while this app is focused.</p>
      <div className="overlay__row"><span>Configured gesture</span>
        <kbd>{state.settings.shortcut}</kbd></div>
      <div className="overlay__row"><span>Navigate screens</span>
        <kbd>Alt + 1…4</kbd></div>
    </Dialog>}
    <Toast message={toast} />
  </>;
}

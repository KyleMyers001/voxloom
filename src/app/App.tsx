import { useEffect, useRef, useState } from "react";
import { Dialog } from "../components/Dialog";
import { Toast } from "../components/Toast";
import { Waveform } from "../components/Waveform";
import { ScenarioPanel } from "../dev/ScenarioPanel";
import { Dictionary } from "../features/dictionary/Dictionary";
import { History } from "../features/history/History";
import { Home } from "../features/home/Home";
import { Onboarding } from "../features/onboarding/Onboarding";
import { Settings } from "../features/settings/Settings";
import type { Screen } from "../domain/types";
import { useApp } from "./AppContext";

const screens: { glyph: string; label: string; value: Screen }[] = [
  { glyph: "⌂", label: "Home", value: "home" },
  { glyph: "↶", label: "History", value: "history" },
  { glyph: "Aa", label: "Dictionary", value: "dictionary" },
  { glyph: "⌘", label: "Settings", value: "settings" },
];

export function App() {
  const { dispatch, now, state } = useApp();
  const [onboardingOpen, setOnboardingOpen] = useState(
    !state.onboarding.complete,
  );
  const [shortcutOpen, setShortcutOpen] = useState(false);
  const [toast, setToast] = useState("");
  const modalOpener = useRef<HTMLElement | null>(null);
  const modalOpen = onboardingOpen || shortcutOpen;

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved = state.settings.appearance === "system"
        ? media.matches ? "dark" : "light"
        : state.settings.appearance;
      document.body.dataset.appearanceResolved = resolved;
    };
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [state.settings.appearance]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (modalOpen) return;
      const target = event.target as HTMLElement;
      const editable = target.matches("input, select, textarea");
      if (event.key === "?" && !editable) {
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
  }, [dispatch, modalOpen]);

  function announce(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 1800);
  }

  function setup(opener: HTMLElement) {
    modalOpener.current = opener;
    setOnboardingOpen(true);
  }

  function dictationControls() {
    const dictation = state.dictation;
    if (dictation.kind === "listening") return <>
      <button className="btn" onClick={() => dispatch({
        runId: dictation.runId,
        type: "process-dictation",
      })}>Finish mock dictation</button>
      <button className="btn danger" onClick={() => dispatch({
        type: "cancel-dictation",
      })}>Cancel</button>
    </>;
    if (dictation.kind === "processing") return <>
      <button className="btn" onClick={() => dispatch({
        now: now(),
        runId: dictation.runId,
        type: "complete-dictation",
      })}>Complete mock result</button>
      <button className="btn danger" onClick={() => dispatch({
        type: "cancel-dictation",
      })}>Cancel</button>
    </>;
    return <button className="btn" onClick={() => dispatch({
      type: "start-dictation",
    })}>Start mock dictation</button>;
  }

  return <>
    <div className="app" id="app-shell" inert={modalOpen}>
      <header className="topbar">
        <div className="topbar__mark">Voxloom</div>
        <span className="badge">Mock prototype</span>
        <div className="topbar__actions">
          {dictationControls()}
          <button aria-label="Open keyboard shortcuts" className="icon-btn"
            onClick={(event) => {
              modalOpener.current = event.currentTarget;
              setShortcutOpen(true);
            }}>?</button>
        </div>
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
        {import.meta.env.DEV && <ScenarioPanel />}
        <p className="review-note">
          Session-only prototype · no audio capture or native shortcut.
        </p>
      </aside>
      <main className="main">
        {state.screen === "home" && <Home onToast={announce} />}
        {state.screen === "history" && <History onToast={announce} />}
        {state.screen === "dictionary" && <Dictionary />}
        {state.screen === "settings" && <Settings onSetup={setup} />}
      </main>
      <Waveform />
    </div>
    {onboardingOpen && <Onboarding onClose={() => setOnboardingOpen(false)}
      opener={modalOpener.current} />}
    {shortcutOpen && <Dialog label="Keyboard shortcuts"
      onClose={() => setShortcutOpen(false)} opener={modalOpener.current}>
      <h2>Keyboard shortcuts</h2>
      <p>Hold or double-tap behavior is simulated only inside this app.</p>
      <div className="overlay__row"><span>Configured gesture</span>
        <kbd>{state.settings.shortcut}</kbd></div>
      <div className="overlay__row"><span>Navigate screens</span>
        <kbd>Alt + 1…4</kbd></div>
    </Dialog>}
    <Toast message={toast} />
  </>;
}

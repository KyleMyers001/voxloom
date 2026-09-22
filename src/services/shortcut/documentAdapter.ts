import type { ShortcutController, ShortcutGesture } from "../contracts";
import type { Scheduler } from "../contracts";
import { DOUBLE_TAP_MS, HOLD_MS } from "./constants";
import { matchesShortcut } from "./formatHotkey";
import { shouldResetGesturesOnDocumentHidden } from "./focusPolicy";
import { createGestureMachine } from "./gestureMachine";

const browserScheduler: Scheduler = {
  clear: (timer) => window.clearTimeout(timer),
  set: (callback, delay) => window.setTimeout(callback, delay),
};

export interface DocumentAdapterOptions {
  clock: () => number;
  doubleTapMs?: number;
  holdMs?: number;
  onGesture: (gesture: ShortcutGesture) => void;
  scheduler?: Scheduler;
  shortcut: string;
  target: Pick<Document, "addEventListener" | "removeEventListener">;
}

/**
 * Focused-window mock: DOM keydown/keyup → gesture machine.
 * Remains valid for Vite / unit tests; not OS-wide registration.
 */
export function createDocumentShortcutController({
  clock,
  doubleTapMs = DOUBLE_TAP_MS,
  holdMs = HOLD_MS,
  onGesture,
  scheduler = browserScheduler,
  shortcut,
  target,
}: DocumentAdapterOptions): ShortcutController {
  const machine = createGestureMachine({
    clock,
    doubleTapMs,
    holdMs,
    onGesture,
    scheduler,
  });

  function keyDown(event: Event) {
    const key = event as KeyboardEvent;
    if (key.repeat || !matchesShortcut(key, shortcut)) return;
    key.preventDefault();
    machine.handle("pressed");
  }

  function keyUp(event: Event) {
    const key = event as KeyboardEvent;
    if (!matchesShortcut(key, shortcut)) return;
    key.preventDefault();
    machine.handle("released");
  }

  function onVisibility() {
    if (
      document.visibilityState === "hidden" &&
      shouldResetGesturesOnDocumentHidden("document-focused")
    ) {
      machine.resetPartial();
    }
  }

  function onPageHide() {
    machine.resetPartial();
  }

  target.addEventListener("keydown", keyDown);
  target.addEventListener("keyup", keyUp);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);

  return {
    dispose() {
      machine.dispose();
      target.removeEventListener("keydown", keyDown);
      target.removeEventListener("keyup", keyUp);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    },
    setContext(value) {
      machine.setContext(value);
    },
  };
}

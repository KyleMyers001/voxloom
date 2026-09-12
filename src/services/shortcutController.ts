import type {
  Scheduler,
  ShortcutController,
  ShortcutGesture,
} from "./contracts";

interface ShortcutOptions {
  clock: () => number;
  doubleTapMs?: number;
  holdMs?: number;
  onGesture: (gesture: ShortcutGesture) => void;
  scheduler?: Scheduler;
  shortcut: string;
  target: Pick<Document, "addEventListener" | "removeEventListener">;
}

const browserScheduler: Scheduler = {
  clear: (timer) => window.clearTimeout(timer),
  set: (callback, delay) => window.setTimeout(callback, delay),
};

function matches(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.toLowerCase().split("+").map((part) => part.trim());
  const key = parts.at(-1);
  const space = key === "space" && event.code === "Space";
  return (space || event.key.toLowerCase() === key) &&
    event.altKey === parts.includes("alt") &&
    event.ctrlKey === parts.includes("ctrl") &&
    event.metaKey === parts.includes("meta") &&
    event.shiftKey === parts.includes("shift");
}

export function createShortcutController({
  clock,
  doubleTapMs = 260,
  holdMs = 320,
  onGesture,
  scheduler = browserScheduler,
  shortcut,
  target,
}: ShortcutOptions): ShortcutController {
  let downAt: number | null = null;
  let holdTimer: number | null = null;
  let holding = false;
  let ignoreUp = false;
  let latched = false;
  let lastTap: number | null = null;
  let tapTimer: number | null = null;

  function clear(timer: number | null) {
    if (timer !== null) scheduler.clear(timer);
  }

  function keyDown(event: Event) {
    const key = event as KeyboardEvent;
    if (key.repeat || downAt !== null || !matches(key, shortcut)) return;
    key.preventDefault();
    if (latched) {
      latched = false;
      ignoreUp = true;
      onGesture("latch-finish");
      return;
    }
    const current = clock();
    if (lastTap !== null && current - lastTap <= doubleTapMs) {
      clear(tapTimer);
      lastTap = null;
      latched = true;
      ignoreUp = true;
      onGesture("latch-start");
      return;
    }
    downAt = current;
    holdTimer = scheduler.set(() => {
      if (downAt === null) return;
      holding = true;
      onGesture("hold-start");
    }, holdMs);
  }

  function keyUp(event: Event) {
    const key = event as KeyboardEvent;
    if (!matches(key, shortcut)) return;
    key.preventDefault();
    if (ignoreUp) {
      ignoreUp = false;
      return;
    }
    clear(holdTimer);
    if (holding) {
      holding = false;
      onGesture("hold-finish");
    } else if (downAt !== null) {
      lastTap = clock();
      tapTimer = scheduler.set(() => {
        lastTap = null;
      }, doubleTapMs);
    }
    downAt = null;
  }

  target.addEventListener("keydown", keyDown);
  target.addEventListener("keyup", keyUp);
  return {
    dispose() {
      clear(holdTimer);
      clear(tapTimer);
      target.removeEventListener("keydown", keyDown);
      target.removeEventListener("keyup", keyUp);
    },
  };
}

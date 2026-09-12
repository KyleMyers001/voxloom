import { useEffect, useRef } from "react";
import { hasOpenModal, subscribeModal } from "./modalState";
import type { AppState } from "./state";
import type { OnboardingState } from "../domain/types";
import type {
  DictationLifecycle,
  SetupLifecycle,
  ShortcutContext,
  ShortcutGesture,
} from "../services/contracts";
import { createShortcutController } from
  "../services/shortcutController";

interface GestureOptions {
  dictation: DictationLifecycle;
  now: () => number;
  onboardingOpen: boolean;
  setup: SetupLifecycle;
  shortcutOpen: boolean;
  state: AppState;
}

export function useShortcutGestures(options: GestureOptions) {
  const controllerRef = useRef<ReturnType<
    typeof createShortcutController
  > | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const controller = createShortcutController({
      clock: options.now,
      onGesture: (gesture) => handleGesture(optionsRef.current, gesture),
      shortcut: options.state.settings.shortcut,
      target: document,
    });
    controllerRef.current = controller;
    const update = () => controller.setContext(
      interactionContext(optionsRef.current),
    );
    const unsubscribe = subscribeModal(update);
    update();
    return () => {
      controllerRef.current = null;
      unsubscribe();
      controller.dispose();
    };
  }, [options.now, options.state.settings.shortcut]);

  useEffect(() => {
    controllerRef.current?.setContext(interactionContext(options));
  }, [options.onboardingOpen, options.shortcutOpen,
    options.state.onboarding.step]);

  useEffect(() => {
    const { dictation, state } = options;
    if (state.dictation.kind !== "processing" ||
        state.dictation.completion !== "automatic") return;
    const { runId } = state.dictation;
    const timer = window.setTimeout(
      () => dictation.complete(runId),
      500,
    );
    return () => window.clearTimeout(timer);
  }, [options.dictation, options.state.dictation]);
}

function handleGesture(options: GestureOptions, gesture: ShortcutGesture) {
  const { dictation, onboardingOpen, shortcutOpen, state } = options;
  if (shortcutOpen) return;
  if (onboardingOpen && state.onboarding.step === 3) {
    handlePractice(options, gesture);
    return;
  }
  if (onboardingOpen) return;
  if (gesture === "hold-start" || gesture === "latch-start") {
    dictation.start();
  } else if ((gesture === "hold-finish" ||
      gesture === "latch-finish") &&
      state.dictation.kind === "listening") {
    dictation.finish(state.dictation.runId);
  }
}

function interactionContext(options: GestureOptions): ShortcutContext {
  if (options.onboardingOpen) {
    return options.state.onboarding.step === 3 ? "practice" : null;
  }
  return options.shortcutOpen || hasOpenModal() ? null : "product";
}

function handlePractice(options: GestureOptions, gesture: ShortcutGesture) {
  const changes: Partial<OnboardingState> = {};
  if (gesture === "hold-start") {
    changes.recognizedText =
      "Hold: preserve the TypeScript identifier.";
  }
  if (gesture === "hold-finish") changes.holdTested = true;
  if (gesture === "latch-start") {
    changes.recognizedText =
      "Double-tap latched. Activate once more to finish.";
  }
  if (gesture === "latch-finish") {
    changes.recognizedText = "Double-tap: keep --dry-run enabled.";
    changes.tapTested = true;
  }
  options.setup.update(changes);
}

import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { hasOpenModal, subscribeModal } from "./modalState";
import type { AppState } from "./state";
import type { OnboardingState } from "../domain/types";
import type {
  DictationLifecycle,
  SetupLifecycle,
  ShortcutContext,
  ShortcutController,
  ShortcutGesture,
} from "../services/contracts";
import { createShortcutController } from
  "../services/shortcutController";
import {
  createNativeShortcutController,
  createOverlayBridge,
  createPendingFinishGate,
  type NativeShortcutController,
  type OverlayBridge,
  type PendingFinishGate,
} from "../services/shortcut";

interface GestureOptions {
  dictation: DictationLifecycle;
  now: () => number;
  onboardingOpen: boolean;
  onShortcutError?: (message: string) => void;
  setup: SetupLifecycle;
  shortcutOpen: boolean;
  state: AppState;
}

const browserScheduler = {
  clear: (timer: number) => window.clearTimeout(timer),
  set: (callback: () => void, delay: number) =>
    window.setTimeout(callback, delay),
};

export function useShortcutGestures(options: GestureOptions) {
  const documentControllerRef = useRef<ShortcutController | null>(null);
  const nativeControllerRef = useRef<NativeShortcutController | null>(null);
  const overlayRef = useRef<OverlayBridge | null>(null);
  const pendingFinishRef = useRef<PendingFinishGate | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Shared pending-finish gate (hold release can race React listening commit).
  if (pendingFinishRef.current === null) {
    pendingFinishRef.current = createPendingFinishGate({
      finish: (runId) => optionsRef.current.dictation.finish(runId),
      listeningRunId: () => {
        const { dictation } = optionsRef.current.state;
        return dictation.kind === "listening" ? dictation.runId : null;
      },
    });
  }

  // Document mock path (Vite / tests) — always available when not Tauri.
  useEffect(() => {
    if (isTauri()) return;
    const controller = createShortcutController({
      clock: options.now,
      onGesture: (gesture) => handleGesture(
        optionsRef.current,
        gesture,
        pendingFinishRef.current,
      ),
      shortcut: options.state.settings.shortcut,
      target: document,
    });
    documentControllerRef.current = controller;
    const update = () => controller.setContext(
      interactionContext(optionsRef.current),
    );
    const unsubscribe = subscribeModal(update);
    update();
    return () => {
      documentControllerRef.current = null;
      unsubscribe();
      controller.dispose();
    };
  }, [options.now, options.state.settings.shortcut]);

  // Native global shortcut (Tauri desktop).
  useEffect(() => {
    if (!isTauri()) return;
    const controller = createNativeShortcutController({
      clock: options.now,
      onGesture: (gesture) => handleGesture(
        optionsRef.current,
        gesture,
        pendingFinishRef.current,
      ),
      onRegisterFailure: (message) => {
        optionsRef.current.onShortcutError?.(message);
      },
      scheduler: browserScheduler,
    });
    nativeControllerRef.current = controller;
    const overlay = createOverlayBridge();
    overlayRef.current = overlay;

    let cancelled = false;
    void (async () => {
      const outcome = await controller.setShortcut(
        optionsRef.current.state.settings.shortcut,
      );
      if (cancelled) return;
      if (!outcome.ok && outcome.message) {
        optionsRef.current.onShortcutError?.(outcome.message);
      }
      controller.setContext(interactionContext(optionsRef.current));
    })();

    const update = () =>
      controller.setContext(interactionContext(optionsRef.current));
    const unsubscribe = subscribeModal(update);

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        controller.resetPartial();
        pendingFinishRef.current?.clear();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      nativeControllerRef.current = null;
      overlayRef.current = null;
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
      pendingFinishRef.current?.clear();
      void controller.dispose();
      void overlay.dispose();
    };
  }, [options.now]);

  // Re-register when Settings shortcut changes (native only).
  useEffect(() => {
    const native = nativeControllerRef.current;
    if (!native || !isTauri()) return;
    let cancelled = false;
    void (async () => {
      const outcome = await native.setShortcut(
        options.state.settings.shortcut,
      );
      if (cancelled) return;
      if (!outcome.ok && outcome.message) {
        options.onShortcutError?.(outcome.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [options.onShortcutError, options.state.settings.shortcut]);

  useEffect(() => {
    const ctx = interactionContext(options);
    documentControllerRef.current?.setContext(ctx);
    nativeControllerRef.current?.setContext(ctx);
  }, [options.onboardingOpen, options.shortcutOpen,
    options.state.onboarding.step]);

  // Overlay visibility follows dictation lifecycle (listening/processing).
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    void overlay.sync(options.state.dictation);
    const kind = options.state.dictation.kind;
    if (kind === "listening") {
      pendingFinishRef.current?.onListening();
    }
    // Cancel / error / success clear gesture partials so latch cannot resume.
    if (
      kind === "cancelled" ||
      kind === "error" ||
      kind === "success" ||
      kind === "ready"
    ) {
      pendingFinishRef.current?.clear();
      nativeControllerRef.current?.resetPartial();
      // Document path resets via context; also clear if mid-hold somehow.
    }
  }, [options.state.dictation]);

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

function handleGesture(
  options: GestureOptions,
  gesture: ShortcutGesture,
  pending: PendingFinishGate | null,
) {
  const { dictation, onboardingOpen, shortcutOpen, state } = options;
  if (shortcutOpen) return;
  if (onboardingOpen && state.onboarding.step === 3) {
    handlePractice(options, gesture);
    return;
  }
  if (onboardingOpen) return;
  // Busy / processing: ignore start; finish only while listening (or pending).
  if (gesture === "hold-start" || gesture === "latch-start") {
    if (
      state.dictation.kind === "listening" ||
      state.dictation.kind === "processing"
    ) {
      return;
    }
    pending?.resetForStart();
    dictation.start();
  } else if (gesture === "hold-finish" || gesture === "latch-finish") {
    if (state.dictation.kind === "listening") {
      const runId = state.dictation.runId;
      if (pending) pending.requestFinish(true, runId);
      else dictation.finish(runId);
    } else if (pending) {
      pending.requestFinish(false, null);
    }
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

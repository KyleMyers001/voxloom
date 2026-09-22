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
import type {
  DogfoodPhase,
  UseDogfoodCaptureResult,
} from "../services/stt/useDogfoodCapture";

/**
 * Product gestures drive real dogfood capture → STT → deliverTranscript.
 * Snapshot runs inside dogfood.start() at gesture invocation (while the
 * other app is still frontmost — global shortcut must not activate Voxloom).
 * Overlay still uses the mock dictation lifecycle; terminal dogfood phases
 * clear it without synthetic Inserted history rows.
 */
export interface GestureDogfoodBridge {
  cancel: () => void;
  phase: DogfoodPhase;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

interface GestureOptions {
  dictation: DictationLifecycle;
  /** Shared Home/gesture dogfood path (BUS-14 follow-up). */
  dogfood: GestureDogfoodBridge;
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

function isDogfoodBusy(phase: DogfoodPhase): boolean {
  return phase === "recording" || phase === "transcribing";
}

function isDogfoodTerminal(phase: DogfoodPhase): boolean {
  return phase === "success"
    || phase === "error"
    || phase === "cancelled";
}

export function useShortcutGestures(options: GestureOptions) {
  const documentControllerRef = useRef<ShortcutController | null>(null);
  const nativeControllerRef = useRef<NativeShortcutController | null>(null);
  const overlayRef = useRef<OverlayBridge | null>(null);
  const pendingFinishRef = useRef<PendingFinishGate | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Shared pending-finish gate (hold release can race React listening commit).
  // Finish → holdProcessing (overlay) + dogfood.stop (real STT/delivery).
  // Never dictation.finish/complete — that path invents synthetic Inserted.
  if (pendingFinishRef.current === null) {
    pendingFinishRef.current = createPendingFinishGate({
      finish: (runId) => {
        optionsRef.current.dictation.holdProcessing(runId);
        void optionsRef.current.dogfood.stop();
      },
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

    // Do NOT resetPartial / clear pending on document visibilitychange.
    // ADR §3: other-app focus must keep an in-flight native hold alive;
    // visibility hidden is normal while dictating into another app.
    // (Document mock still resets on hide — it would miss keyup.)

    return () => {
      cancelled = true;
      nativeControllerRef.current = null;
      overlayRef.current = null;
      unsubscribe();
      pendingFinishRef.current?.clear();
      void controller.dispose();
      void overlay.dispose();
    };
  }, [options.now]);

  // Re-register when Settings shortcut *changes* (native only).
  // Mount effect owns the initial bind; skipping that first run avoids a
  // parallel setShortcut for the same combo on boot (Mac RegisterEventHotKey
  // race). Controller still serializes setShortcut as a safety net.
  const boundShortcutRef = useRef<string | null>(null);
  useEffect(() => {
    const native = nativeControllerRef.current;
    if (!native || !isTauri()) return;
    const shortcut = options.state.settings.shortcut;
    if (boundShortcutRef.current === null) {
      boundShortcutRef.current = shortcut;
      return;
    }
    if (boundShortcutRef.current === shortcut) return;
    boundShortcutRef.current = shortcut;
    let cancelled = false;
    void (async () => {
      const outcome = await native.setShortcut(shortcut);
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

  // When dogfood leaves recording/transcribing, clear overlay dictation
  // without inventing a synthetic Inserted history row.
  useEffect(() => {
    const { dictation, dogfood, state } = options;
    if (!isDogfoodTerminal(dogfood.phase)) return;
    const d = state.dictation;
    if (d.kind === "listening" || d.kind === "processing") {
      dictation.cancel(d.runId);
    }
  }, [options.dogfood.phase, options.dictation, options.state.dictation]);

  // If stop raced ahead of holdProcessing, promote listening → processing
  // once dogfood is transcribing so overlay stays up during STT.
  useEffect(() => {
    const { dictation, dogfood, state } = options;
    if (dogfood.phase !== "transcribing") return;
    if (state.dictation.kind === "listening") {
      dictation.holdProcessing(state.dictation.runId);
    }
  }, [options.dogfood.phase, options.dictation, options.state.dictation]);
}

function handleGesture(
  options: GestureOptions,
  gesture: ShortcutGesture,
  pending: PendingFinishGate | null,
) {
  const { dictation, dogfood, onboardingOpen, shortcutOpen, state } = options;
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
      state.dictation.kind === "processing" ||
      isDogfoodBusy(dogfood.phase)
    ) {
      return;
    }
    pending?.resetForStart();
    // Overlay first (sync), then real capture. dogfood.start snapshots the
    // frontmost app *before* mic work — global shortcut must not activate
    // Voxloom (ADR §4). Home Start may still Copy when Voxloom is focused.
    dictation.start();
    void dogfood.start();
  } else if (gesture === "hold-finish" || gesture === "latch-finish") {
    if (state.dictation.kind === "listening") {
      const runId = state.dictation.runId;
      if (pending) pending.requestFinish(true, runId);
      else {
        dictation.holdProcessing(runId);
        void dogfood.stop();
      }
    } else if (pending) {
      pending.requestFinish(false, null);
    } else if (isDogfoodBusy(dogfood.phase)) {
      // Dictation overlay not listening yet, but capture may have started.
      void dogfood.stop();
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

/** Test/helper: narrow UseDogfoodCaptureResult to the gesture bridge. */
export function toGestureDogfoodBridge(
  dogfood: UseDogfoodCaptureResult,
): GestureDogfoodBridge {
  return {
    cancel: dogfood.cancel,
    phase: dogfood.phase,
    start: dogfood.start,
    stop: dogfood.stop,
  };
}

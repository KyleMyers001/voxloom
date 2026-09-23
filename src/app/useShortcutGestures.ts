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
 * Overlay visibility is torn down on finish/cancel/error unconditionally
 * (try/finally) so a failed stop/STT/deliver cannot leave the waveform up.
 * Dogfood terminal (Home Stop / success / error / cancel) also forces overlay
 * clear — do not rely only on gesture finish (Clara: Stop clears capture but
 * waveform stayed). That teardown is **edge-triggered** on the phase
 * transition only: the phase stays "success"/"cancelled" until the next
 * start, so re-running it on every dictation change cancelled the *next*
 * hold's listening run in the same commit (no overlay, machine reset, release
 * lost, Home stuck on Stop — the 2nd/3rd-hold failures on a161e1f…dbe5748).
 * New holds abandon leftover *recording* dogfood before starting; an
 * in-flight transcription is left to finish in the background.
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

/**
 * Hide waveform: cancel listening|processing so overlay sync goes invisible.
 * With `runId`, only that run is cancelled — a later run (new hold) is kept.
 */
function tearDownOverlayDictation(
  options: GestureOptions,
  runId?: number,
): void {
  const d = options.state.dictation;
  if (d.kind !== "listening" && d.kind !== "processing") return;
  if (runId !== undefined && d.runId !== runId) return;
  options.dictation.cancel(d.runId);
}

/** Dictation run the overlay currently shows, if any. */
function visibleRunId(options: GestureOptions): number | null {
  const d = options.state.dictation;
  return d.kind === "listening" || d.kind === "processing" ? d.runId : null;
}

/**
 * Finish hold/latch: stop capture for STT/delivery, but always clear overlay
 * even when stop throws or races ahead of React listening commit.
 * Never dictation.finish/complete — that invents synthetic Inserted rows.
 */
function endGestureCapture(optionsRef: { current: GestureOptions }): void {
  // Immediate clear on release (Clara: overlay must not wait for STT).
  const runId = visibleRunId(optionsRef.current);
  tearDownOverlayDictation(optionsRef.current);
  void (async () => {
    try {
      await optionsRef.current.dogfood.stop();
    } catch {
      // stop / STT / deliver failure must not leave overlay up
    } finally {
      // Only this run — a new hold may already be listening by now.
      if (runId !== null) tearDownOverlayDictation(optionsRef.current, runId);
    }
  })();
}

/**
 * Last dogfood phase the terminal-teardown effect has acted on. Shared with
 * handleGesture so a hold-start that itself cancels leftover dogfood can mark
 * the resulting "cancelled" as handled before React commits it together with
 * the new listening run.
 */
interface PhaseGuard {
  seen: DogfoodPhase;
}

export function useShortcutGestures(options: GestureOptions) {
  const documentControllerRef = useRef<ShortcutController | null>(null);
  const nativeControllerRef = useRef<NativeShortcutController | null>(null);
  const overlayRef = useRef<OverlayBridge | null>(null);
  const pendingFinishRef = useRef<PendingFinishGate | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const phaseGuardRef = useRef<PhaseGuard>({ seen: options.dogfood.phase });

  // Shared pending-finish gate (hold release can race React listening commit).
  // Finish → dogfood.stop (real STT/delivery) + unconditional overlay teardown.
  // Never dictation.finish/complete — that path invents synthetic Inserted.
  if (pendingFinishRef.current === null) {
    pendingFinishRef.current = createPendingFinishGate({
      finish: () => {
        endGestureCapture(optionsRef);
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
        optionsRef,
        phaseGuardRef.current,
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
        optionsRef,
        phaseGuardRef.current,
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

  // When dogfood *enters* success/error/cancelled, guarantee overlay
  // dictation is cleared without synthetic Inserted rows (Home Stop / cancel
  // / error when gesture finish never ran). Edge-triggered on the phase
  // transition only: the phase stays terminal until the next start, and the
  // next hold's listening run commits while it is still terminal.
  useEffect(() => {
    const guard = phaseGuardRef.current;
    const phase = options.dogfood.phase;
    if (phase === guard.seen) return;
    guard.seen = phase;
    if (!isDogfoodTerminal(phase)) return;
    tearDownOverlayDictation(optionsRef.current);
    // Force hide even if cancel no-ops (runId race) or React dictation
    // commit lags — overlay sync to a non-visible kind.
    const overlay = overlayRef.current;
    if (overlay) {
      void overlay.sync({ kind: "ready" });
    }
  }, [options.dogfood.phase]);
}

function handleGesture(
  options: GestureOptions,
  gesture: ShortcutGesture,
  pending: PendingFinishGate | null,
  optionsRef: { current: GestureOptions },
  phaseGuard: PhaseGuard,
) {
  const { dictation, dogfood, onboardingOpen, shortcutOpen, state } = options;
  if (shortcutOpen) return;
  if (onboardingOpen && state.onboarding.step === 3) {
    handlePractice(options, gesture);
    return;
  }
  if (onboardingOpen) return;
  if (gesture === "hold-start" || gesture === "latch-start") {
    // Leftover overlay run (missed finish): clear it before the new run.
    tearDownOverlayDictation(options);
    if (dogfood.phase === "recording") {
      // Prior capture never stopped (Home Start / missed hold-finish):
      // abandon it so the new hold can start — never silently ignore as busy.
      // Mark the resulting "cancelled" as handled: it commits in the same
      // React batch as the new listening run, which must survive.
      dogfood.cancel();
      phaseGuard.seen = "cancelled";
    }
    // "transcribing": prior utterance's STT/delivery keeps running in the
    // background; dogfood.start() supersedes its phase (session-guarded).
    pending?.resetForStart();
    // Overlay first (sync), then real capture. dogfood.start snapshots the
    // frontmost app *before* mic work — global shortcut must not activate
    // Voxloom (ADR §4). Home Start may still Copy when Voxloom is focused.
    dictation.start();
    void dogfood.start().catch(() => {
      // start failure → tear down overlay (phase effect also covers terminal)
      tearDownOverlayDictation(optionsRef.current);
    });
  } else if (gesture === "hold-finish" || gesture === "latch-finish") {
    if (state.dictation.kind === "listening") {
      const runId = state.dictation.runId;
      if (pending) pending.requestFinish(true, runId);
      else endGestureCapture(optionsRef);
    } else if (pending) {
      pending.requestFinish(false, null);
    } else if (isDogfoodBusy(dogfood.phase)) {
      // Dictation overlay not listening yet, but capture may have started.
      endGestureCapture(optionsRef);
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

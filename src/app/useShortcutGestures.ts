import { isTauri } from '@tauri-apps/api/core';
import type { OverlayResult } from '../services/shortcut/overlayVisibility';
import { useEffect, useRef } from 'react';
import { subscribeModal } from './modalState';
import { handlePractice, interactionContext } from './gestureContext';
import { suspendable } from '../services/shortcut/recordingSuspend';
import type { AppState } from './state';
import type {
  DictationLifecycle,
  SetupLifecycle,
  ShortcutController,
  ShortcutGesture,
} from '../services/contracts';
import { createShortcutController } from
  '../services/shortcutController';
import {
  createNativeShortcutController,
  createOverlayBridge,
  createPendingFinishGate,
  type NativeShortcutController,
  type OverlayBridge,
  type PendingFinishGate,
} from '../services/shortcut';
import { useShortcutRegistration } from './useShortcutRegistration';
import { bootRefusedText } from '../features/settings/shortcutCopy';
import { answerShortcutQueries, emitShortcutBound } from '../services/shortcut/bindingEvents';
import { subscribe } from '../services/settingsWindow';
import type {
  DogfoodPhase,
  UseDogfoodCaptureResult,
} from '../services/stt/useDogfoodCapture';

/**
 * Product gestures drive real dogfood capture → STT → deliverTranscript.
 * Target snapshot dispatch runs after transcription completes, not at the
 * finish edge. No product path activates another app.
 * Overlay visibility is torn down on finish/cancel/error unconditionally
 * (try/finally) so a failed stop/STT/deliver cannot leave the waveform up.
 * Dogfood terminal (Home Stop / success / error / cancel) also forces overlay
 * clear — do not rely only on gesture finish (Stop clears capture but
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
  /** Result HUD for the finished run (Copied / failure); null or absent shows nothing. */
  hudResult?: OverlayResult | null;
  origin?: 'home' | 'gesture' | null;
  phase: DogfoodPhase;
  scopeReady: boolean;
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
  /** BUS-47: registration failed; put this last-good combo back in settings. */
  onShortcutRevert?: (shortcut: string) => void;
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
  return phase === 'recording' || phase === 'transcribing';
}

function isDogfoodTerminal(phase: DogfoodPhase): boolean {
  return phase === 'success'
    || phase === 'error'
    || phase === 'cancelled';
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
  if (d.kind !== 'listening' && d.kind !== 'processing') return;
  if (runId !== undefined && d.runId !== runId) return;
  options.dictation.cancel(d.runId);
}


/**
 * Finish hold/latch: stop capture for STT/delivery, but always clear overlay
 * even when stop throws or races ahead of React listening commit.
 * Never dictation.finish/complete — that invents synthetic Inserted rows.
 */
function endGestureCapture(optionsRef: { current: GestureOptions }): void {
  // The audio stop already ran at the gesture edge. This
  // gate only tears down an overlay whose listening commit may arrive late.
  tearDownOverlayDictation(optionsRef.current);
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
  /** Last combo the OS accepted (settings format); the revert target. */
  const registeredRef = useRef<string | null>(null);
  optionsRef.current = options;
  const phaseGuardRef = useRef<PhaseGuard>({ seen: options.dogfood.phase });

  // Shared pending-finish gate (hold release can race React listening commit).
  // Finish stops audio immediately; this gate handles only overlay teardown.
  // Never dictation.finish/complete — that path invents synthetic Inserted.
  if (pendingFinishRef.current === null) {
    pendingFinishRef.current = createPendingFinishGate({
      finish: () => {
        endGestureCapture(optionsRef);
      },
      listeningRunId: () => {
        const { dictation } = optionsRef.current.state;
        return dictation.kind === 'listening' ? dictation.runId : null;
      },
    });
  }

  // Document mock path (Vite / tests) — always available when not Tauri.
  useEffect(() => {
    if (isTauri()) return;
    const controller = createShortcutController({
      clock: options.now,
      onGesture: suspendable((gesture) => handleGesture(
        optionsRef.current, gesture, pendingFinishRef.current, optionsRef, phaseGuardRef.current,
      )),
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
      onGesture: suspendable((gesture) => handleGesture(
        optionsRef.current, gesture, pendingFinishRef.current, optionsRef, phaseGuardRef.current,
      )),
      // No onRegisterFailure toast: registration outcomes are reported once,
      // in words, by the boot path below and useShortcutRegistration.
      scheduler: browserScheduler,
    });
    nativeControllerRef.current = controller;
    const overlay = createOverlayBridge();
    overlayRef.current = overlay;

    let cancelled = false;
    void (async () => {
      const bootShortcut = optionsRef.current.state.settings.shortcut;
      const outcome = await controller.setShortcut(bootShortcut);
      // Seed the revert target from what the OS accepted, not from settings.
      registeredRef.current = outcome.ok ? bootShortcut : null;
      // Tell every window (Home, sidebar, Settings) what the OS holds now.
      emitShortcutBound({
        active: outcome.ok ? bootShortcut : outcome.active ?? null,
        ok: outcome.ok, shortcut: bootShortcut,
      });
      if (cancelled) return;
      if (!outcome.ok) {
        optionsRef.current.onShortcutError?.(bootRefusedText(bootShortcut, outcome.active));
      }
      controller.setContext(interactionContext(optionsRef.current));
    })();

    const update = () =>
      controller.setContext(interactionContext(optionsRef.current));
    const unsubscribe = subscribeModal(update);
    const unanswer = subscribe(answerShortcutQueries);

    // Do NOT resetPartial / clear pending on document visibilitychange.
    // ADR §3: other-app focus must keep an in-flight native hold alive;
    // visibility hidden is normal while dictating into another app.
    // (Document mock still resets on hide — it would miss keyup.)

    return () => {
      cancelled = true;
      nativeControllerRef.current = null;
      overlayRef.current = null;
      unsubscribe();
      unanswer();
      pendingFinishRef.current?.clear();
      void controller.dispose();
      void overlay.dispose();
    };
  }, [options.now]);

  useShortcutRegistration(
    options.state.settings.shortcut, nativeControllerRef, registeredRef, optionsRef,
  );

  useEffect(() => {
    const ctx = interactionContext(options);
    documentControllerRef.current?.setContext(ctx);
    nativeControllerRef.current?.setContext(ctx);
  }, [options.onboardingOpen, options.shortcutOpen,
    options.state.onboarding.step]);

  // Gesture runs and Home capture share the single native overlay.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const phase = options.dogfood.phase;
    const homeRecording = phase === 'starting'
      || (options.dogfood.origin === 'home' && phase === 'recording');
    // The gesture state is cleared on release; STT still owns a cancellable HUD.
    const visualState = phase === 'transcribing'
      ? { kind: 'processing' as const, completion: 'held' as const, runId: -1 }
      : options.state.dictation;
    // Arming can lag the starting/listening render. Hide until ready, then
    // resync even if model/microphone startup has not changed the phase.
    void overlay.sync(options.dogfood.scopeReady ? visualState : { kind: 'ready' },
      options.dogfood.scopeReady && homeRecording);
    const kind = options.state.dictation.kind;
    if (kind === 'listening') {
      pendingFinishRef.current?.onListening();
    }
    // Cancel / error / success clear gesture partials so latch cannot resume.
    if (
      kind === 'cancelled' ||
      kind === 'error' ||
      kind === 'success' ||
      kind === 'ready'
    ) {
      pendingFinishRef.current?.clear();
      nativeControllerRef.current?.resetPartial();
      // Document path resets via context; also clear if mid-hold somehow.
    }
  }, [options.state.dictation, options.dogfood.origin,
    options.dogfood.phase, options.dogfood.scopeReady]);

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
    const { hudResult, origin } = optionsRef.current.dogfood;
    // HUD rules 3–6: Copied / failure flash briefly for gesture runs (the
    // bridge holds off the teardown hide); everything else hides at once.
    const overlay = overlayRef.current;
    if (overlay && origin === 'gesture' && hudResult && phase !== 'cancelled') {
      void overlay.showResult(hudResult);
    }
    tearDownOverlayDictation(optionsRef.current);
    // Force hide even if cancel no-ops (runId race) or React dictation
    // commit lags — overlay sync to a non-visible kind.
    if (overlay) {
      void overlay.sync({ kind: 'ready' });
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
  if (gesture === 'hold-start' || gesture === 'latch-start') {
    // Leftover overlay run (missed finish): clear it before the new run.
    tearDownOverlayDictation(options);
    if (dogfood.phase === 'recording') {
      // Prior capture never stopped (Home Start / missed hold-finish):
      // abandon it so the new hold can start — never silently ignore as busy.
      // Mark the resulting "cancelled" as handled: it commits in the same
      // React batch as the new listening run, which must survive.
      dogfood.cancel();
      phaseGuard.seen = 'cancelled';
    }
    // "transcribing": prior utterance's STT/delivery keeps running in the
    // background; dogfood.start() supersedes its phase (session-guarded).
    pending?.resetForStart();
    // Overlay first (sync), then real capture. Target selection waits until
    // final transcription; global shortcut must not activate Voxloom (ADR §4).
    dictation.start();
    void dogfood.start().catch(() => {
      // start failure → tear down overlay (phase effect also covers terminal)
      tearDownOverlayDictation(optionsRef.current);
    });
  } else if (gesture === 'hold-finish' || gesture === 'latch-finish') {
    // Stop audio now, before the pending-listening gate or overlay work.
    // A release racing model/microphone startup must also latch stop now.
    void dogfood.stop().catch(() => {});
    if (state.dictation.kind === 'listening') {
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

/** Test/helper: narrow UseDogfoodCaptureResult to the gesture bridge. */
export function toGestureDogfoodBridge(
  dogfood: UseDogfoodCaptureResult,
): GestureDogfoodBridge {
  return {
    cancel: dogfood.cancel,
    scopeReady: dogfood.scopeReady,
    hudResult: dogfood.hudResult,
    origin: dogfood.origin,
    phase: dogfood.phase,
    start: () => dogfood.start('gesture'),
    stop: dogfood.stop,
  };
}

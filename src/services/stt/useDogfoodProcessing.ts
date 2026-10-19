/// Post-stop processing for dogfood capture: STT → optional local cleanup
/// (BUS-16) → delivery → History record. Runs on every clean stop (user stop
/// or the 120s/capacity bound) with the same completion-time target policy
/// (ADR §4). A cancel during cleanup delivers nothing.

import { useCallback, useEffect, useRef } from 'react';
import { createDogfoodRecord } from '../../domain/records';
import type { CaptureState } from '../capture/types';
import type { ClipboardAdapter } from '../clipboard';
import type { CleanupEngine } from '../cleanup/contracts';
import {
  createStubDeliveryAdapter,
  createTauriDeliveryAdapter,
  type DeliveryPlatformAdapter,
} from '../delivery';
import { prepareDogfoodCleanup } from './dogfoodCleanup';
import { errorText } from './dogfoodModel';
import { dogfoodTranscribeAndCopy, type CaptureAudioMeta } from './dogfoodPath';
import { hudResultFor, type DogfoodViewActions } from './dogfoodPhase';
import type { DogfoodLiveSession } from './dogfoodSessionState';
import type { UseDogfoodCaptureOptions } from './useDogfoodCapture';

function resolvePlatform(
  clipboard: ClipboardAdapter,
  injected?: DeliveryPlatformAdapter,
): DeliveryPlatformAdapter {
  if (injected) return injected;
  try {
    return createTauriDeliveryAdapter(clipboard);
  } catch {
    return createStubDeliveryAdapter({ clipboard });
  }
}

export interface DogfoodProcessingInput {
  actions: DogfoodViewActions;
  captureState: CaptureState;
  cleanupEngine: () => CleanupEngine;
  /** Resolves the selected model id or throws `model-missing`. */
  ensureModel: () => Promise<string>;
  live: DogfoodLiveSession;
  options: UseDogfoodCaptureOptions;
}

export function useDogfoodProcessing({
  actions, captureState, cleanupEngine, ensureModel, live, options,
}: DogfoodProcessingInput): void {
  // Latest render's options, read when each step of a run needs them.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const platformRef = useRef<DeliveryPlatformAdapter>(
    resolvePlatform(options.clipboard, options.deliveryPlatform),
  );
  platformRef.current = resolvePlatform(
    options.clipboard,
    options.deliveryPlatform,
  );

  const runDogfood = useCallback(async (audio: CaptureAudioMeta) => {
    const {
      announce, announceError, errorToast, setHudResult, setIntendedTarget, setPhase,
      setTranscript, toast,
    } = actions;
    const session = live.session;
    const cancellation = live.cancellation;
    const current = () => session === live.session && !cancellation.cancelled;
    const platform = platformRef.current;
    let settlement: Promise<void> | undefined;
    // Both STT success and failure must consult the native latch, whose
    // notification may still be queued. Share the barrier so it runs once.
    const settleCancellation = () => settlement ??= (async () => {
      if (cancellation.cancelled) return;
      const scope = cancellation.scope;
      if (scope) {
        let accepted = false;
        try { accepted = await scope.finish(); } catch { /* fail closed */ }
        if (!accepted) {
          cancellation.cancelled = true;
          if (session === live.session) live.cancelAction();
          return;
        }
      }
      if (current()) live.active = false;
    })();
    cancellation.settle = settleCancellation;
    const processing = new AbortController();
    live.processing = processing;
    // Snapshot at stop: a settings change mid-dictation applies to the next
    // one. The same style goes to cleanup and onto the History row.
    const latest = optionsRef.current;
    const style = latest.style ?? 'formal';
    const cleanup = prepareDogfoodCleanup({
      controller: processing,
      engine: cleanupEngine,
      onStart: () => {
        if (!current()) return;
        setPhase('cleaning');
        announce('Cleaning up…');
      },
      requestId: `cleanup-${audio.id}`,
      settings: {
        active: latest.cleanupActive === true,
        dictionary: latest.dictionary ?? [],
        modelId: latest.cleanupModelId ?? null,
        style,
      },
      userCancelled: () => cancellation.cancelled,
    });
    setPhase('transcribing');
    announce('Transcribing…');
    try {
      const modelId = await ensureModel();
      if (cancellation.cancelled) return;
      const dogfood = optionsRef.current.dogfood ?? dogfoodTranscribeAndCopy;
      const result = await dogfood({
        audio,
        cleanup: cleanup.stage,
        clipboard: optionsRef.current.clipboard,
        clipboardFallback: optionsRef.current.clipboardFallback !== false,
        deliveryPlatform: platform,
        isCurrent: current,
        beforeDelivery: settleCancellation,
        snapshotTarget: async () => {
          const target = await platform.snapshotTarget();
          if (current()) setIntendedTarget(target);
          return target;
        },
        modelId,
      });
      // A stale successful path skips beforeDelivery, but still needs the
      // saved cancellation decision before publishing History or a toast.
      await settleCancellation();
      if (cancellation.cancelled) return;
      if (current()) {
        setTranscript(result.transcript);
        setHudResult(hudResultFor(result.delivery));
        setPhase('success');
      }
      const provenance = await cleanup.provenance(result.cleanup);
      const record = createDogfoodRecord({
        cleanup: provenance,
        durationMs: audio.duration_ms,
        id: `dogfood-${audio.id}`,
        mayHaveInserted: result.delivery.mayHaveInserted,
        model: modelId,
        now: (optionsRef.current.now ?? Date.now)(),
        rawText: result.transcript.rawText,
        status: result.delivery.status,
        style,
        text: result.transcript.text,
      });
      if (record) {
        optionsRef.current.onHistoryRecord?.(record);
      }
      // Stale session: evidence still surfaces as a toast, phase untouched.
      if (current()) announce(result.delivery.message);
      else toast(result.delivery.message);
    } catch (error: unknown) {
      await settleCancellation();
      if (cancellation.cancelled) return;
      if (current()) {
        setHudResult('transcribe-failed');
        setPhase('error');
        announceError(errorText(error));
      } else {
        errorToast(errorText(error));
      }
    } finally {
      if (live.processing === processing) live.processing = null;
      await cancellation.scope?.dispose().catch(() => {});
    }
  }, [actions, cleanupEngine, ensureModel, live]);

  useEffect(() => {
    const { announceError, setMessage, setPhase } = actions;
    // An older capture's cancel/error (the event that released the mic for
    // a restart) must not end the newer live session.
    const terminal = captureState.kind === 'cancelled' || captureState.kind === 'error';
    if (terminal && live.active && live.captureSession !== live.session) return;
    if (captureState.kind === 'cancelled') {
      setPhase('cancelled');
      setMessage('Capture cancelled — nothing transcribed.');
      return;
    }
    if (captureState.kind === 'error') {
      setPhase('error');
      setMessage(captureState.message);
      return;
    }
    if (captureState.kind !== 'stopped') return;
    const audio = captureState.audio;
    if (!audio) {
      setPhase('error');
      announceError('Capture stopped without audio — nothing to transcribe.');
      return;
    }
    if (live.handledAudioId === audio.id) return;
    live.handledAudioId = audio.id;
    void runDogfood(audio);
  }, [actions, captureState, live, runDogfood]);
}

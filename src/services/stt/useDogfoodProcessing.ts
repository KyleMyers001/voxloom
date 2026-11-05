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
  type PasteBinding,
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
}: DogfoodProcessingInput): () => Promise<PasteBinding | null> {
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

  // Called by start(): the paste terminal in front right now. Any failure or
  // missing support reads as "none", so delivery behaves as before the paste route.
  const lookupPasteBinding = useCallback(async (): Promise<PasteBinding | null> => {
    try {
      return (await platformRef.current.pasteBinding?.()) ?? null;
    } catch {
      return null;
    }
  }, []);

  const runDogfood = useCallback(async (audio: CaptureAudioMeta) => {
    const { announce, setHudResult, setIntendedTarget, setMessage, setPhase, setTranscript, toast } = actions;
    const session = live.session;
    const startBinding = live.pasteBinding;
    const cancellation = live.cancellation;
    cancellation.transcribing = true;
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
    let stopWaitingForBinding: (() => void) | undefined;
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
      const modelId = cancellation.modelId ?? await ensureModel();
      if (cancellation.cancelled && !cancellation.preparation) return;
      // A prepared request must receive stopped PCM even on cancellation: native
      // consumes the handle before refusing the cancelled request. Do not retain
      // that PCM behind an obsolete, potentially stalled start-binding lookup.
      const binding = cancellation.preparation
        ? Promise.race([startBinding, new Promise<null>((resolve) => {
          stopWaitingForBinding = () => resolve(null);
          processing.signal.addEventListener('abort', stopWaitingForBinding, { once: true });
        })])
        : startBinding;
      const pasteBinding = cancellation.cancelled ? null : (await binding) ?? null;
      if (cancellation.cancelled) {
        if (!cancellation.preparation) return;
        await cancellation.preparation.cancel().catch(() => {});
      }
      const dogfood = optionsRef.current.dogfood ?? dogfoodTranscribeAndCopy;
      const result = await dogfood({
        audio,
        cleanup: cleanup.stage,
        clipboard: optionsRef.current.clipboard,
        clipboardFallback: optionsRef.current.clipboardFallback !== false,
        deliveryPlatform: platform,
        dictionary: latest.dictionary,
        isCurrent: current,
        pasteBinding,
        beforeDelivery: settleCancellation,
        snapshotTarget: async () => {
          const target = await platform.snapshotTarget();
          if (current()) setIntendedTarget(target);
          return target;
        },
        modelId,
        requestId: cancellation.preparation?.requestId,
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
      // An empty message is a clean terminal paste: silent, no status line, no
      // toast (History keeps the Unverified record). Clear the stale status.
      const said = result.delivery.message;
      if (!said) {
        if (current()) setMessage(null);
      } else if (current()) announce(said);
      else toast(said);
    } catch (error: unknown) {
      await settleCancellation();
      if (cancellation.cancelled) return;
      if (current()) {
        setHudResult('transcribe-failed');
        setPhase('error');
        announce(errorText(error));
      } else {
        toast(errorText(error));
      }
    } finally {
      if (stopWaitingForBinding) processing.signal.removeEventListener('abort', stopWaitingForBinding);
      await cancellation.preparation?.release(audio.id).catch(() => {});
      if (live.processing === processing) live.processing = null;
      await cancellation.scope?.dispose().catch(() => {});
    }
  }, [actions, cleanupEngine, ensureModel, live]);

  useEffect(() => {
    const { announce, setMessage, setPhase } = actions;
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
      announce('Capture stopped without audio — nothing to transcribe.');
      return;
    }
    if (live.handledAudioId === audio.id) return;
    live.handledAudioId = audio.id;
    if (live.cancellation.cancelled) {
      // A late stopped event must dispose PCM without restarting cancelled STT.
      void live.cancellation.preparation?.release(audio.id).catch(() => {});
      return;
    }
    void runDogfood(audio);
  }, [actions, captureState, live, runDogfood]);

  return lookupPasteBinding;
}

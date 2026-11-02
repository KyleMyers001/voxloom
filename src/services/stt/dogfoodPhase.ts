/// Dogfood capture phase, announce, and HUD state.

import { useCallback, useMemo, useRef, useState } from 'react';
import type { TargetSnapshot } from '../delivery';
import type { DeliveryOutcome } from '../delivery/types';
import type { OverlayResult } from '../shortcut/overlayVisibility';
import type { Transcript } from './types';

export type DogfoodPhase =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'transcribing'
  | 'cleaning'
  | 'success'
  | 'error'
  | 'cancelled';

export type DogfoodOrigin = 'home' | 'gesture';

/**
 * HUD rules 3–6: only Copied (or maybe-copied) and a definite failure show
 * anything after delivery. Unverified and "may have been inserted, nothing
 * copied" dismiss silently like a success; History keeps the
 * Unverified badge.
 */
export function hudResultFor(
  { mayHaveInserted = false, status }: Pick<DeliveryOutcome, 'mayHaveInserted' | 'status'>,
): OverlayResult | null {
  if (status === 'copied') return mayHaveInserted ? 'maybe-copied' : 'copied';
  if (status === 'failed') return mayHaveInserted ? null : 'insert-failed';
  return null; // inserted, unverified, or may-have-inserted: silent dismiss
}

/** Phases the HUD shows and Escape can cancel. */
export function cancellablePhase(phase: DogfoodPhase): boolean {
  return phase === 'starting' || phase === 'recording'
    || phase === 'transcribing' || phase === 'cleaning';
}

export interface DogfoodViewState {
  hudReady: boolean;
  hudResult: OverlayResult | null;
  intendedTarget: TargetSnapshot | null;
  message: string | null;
  origin: DogfoodOrigin | null;
  phase: DogfoodPhase;
  scopeReady: boolean;
  transcript: Transcript | null;
}

/** Stable setters plus announce (message + toast) and toast-only. */
export interface DogfoodViewActions {
  announce: (text: string) => void;
  /** Message + error toast (error tone; falls back to the plain toast). */
  announceError: (text: string) => void;
  /** Error toast only; falls back to the plain toast. */
  errorToast: (text: string) => void;
  setHudReady: (ready: boolean) => void;
  setHudResult: (result: OverlayResult | null) => void;
  setIntendedTarget: (target: TargetSnapshot | null) => void;
  setMessage: (message: string | null) => void;
  setOrigin: (origin: DogfoodOrigin | null) => void;
  setPhase: (phase: DogfoodPhase) => void;
  setScopeReady: (ready: boolean) => void;
  setTranscript: (transcript: Transcript | null) => void;
  toast: (text: string) => void;
}

export function useDogfoodView(
  onToast?: (message: string) => void,
  onErrorToast?: (message: string) => void,
): { actions: DogfoodViewActions; state: DogfoodViewState } {
  const [phase, setPhase] = useState<DogfoodPhase>('idle');
  const [scopeReady, setScopeReady] = useState(false);
  const [hudReady, setHudReady] = useState(false);
  const [hudResult, setHudResult] = useState<OverlayResult | null>(null);
  const [origin, setOrigin] = useState<DogfoodOrigin | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [intendedTarget, setIntendedTarget] =
    useState<TargetSnapshot | null>(null);

  const toastRef = useRef(onToast);
  toastRef.current = onToast;
  const toast = useCallback((text: string) => {
    toastRef.current?.(text);
  }, []);
  const announce = useCallback((text: string) => {
    setMessage(text);
    toastRef.current?.(text);
  }, []);
  const errorToastRef = useRef(onErrorToast);
  errorToastRef.current = onErrorToast;
  const errorToast = useCallback((text: string) => {
    (errorToastRef.current ?? toastRef.current)?.(text);
  }, []);
  const announceError = useCallback((text: string) => {
    setMessage(text);
    errorToast(text);
  }, [errorToast]);

  // Every member is stable, so callers can depend on `actions` freely.
  const actions = useMemo(() => ({
    announce,
    announceError,
    errorToast,
    setHudReady,
    setHudResult,
    setIntendedTarget,
    setMessage,
    setOrigin,
    setPhase,
    setScopeReady,
    setTranscript,
    toast,
  }), [announce, announceError, errorToast, toast]);

  return {
    actions,
    state: {
      hudReady, hudResult, intendedTarget, message, origin, phase, scopeReady, transcript,
    },
  };
}

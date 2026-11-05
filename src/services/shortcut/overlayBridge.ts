import type { DictationState } from '../../domain/types';
import { OVERLAY_LISTEN_PLACEMENT, OVERLAY_RESULT_PLACEMENT } from './constants';
import { createTauriOverlayApi } from './overlayWindowApi';
import {
  isOverlayVisible,
  overlayWaveformFromDictation,
  RESULT_HOLD_MS,
  resultWaveform,
  type OverlayResult,
  type OverlayWaveform,
} from './overlayVisibility';

export interface OverlayBridge {
  dispose(): Promise<void>;
  /** `cancellable` false: show without claiming the native Escape scope. */
  sync(dictation: DictationState, homeRecording?: boolean, cancellable?: boolean): Promise<void>;
  /**
   * Brief result state after a gesture run (Copied ~1.5 s, failure ~2.5 s),
   * then hide. Hides that sync() asks for meanwhile are held off; a new
   * visible state (the next listening run) supersedes it at once.
   */
  showResult(result: OverlayResult): Promise<void>;
}

/** Window size and its gap above the work area's bottom edge, in logical points. */
export interface OverlayPlacement { width: number; height: number; marginBottom: number }

export interface OverlayWindowApi {
  ensureCreated(): Promise<void>;
  hide(): Promise<void>;
  isAvailable(): boolean;
  setWaveform(waveform: OverlayWaveform, result?: OverlayResult): Promise<void>;
  showBottomCenter(placement: OverlayPlacement, cancellable?: boolean): Promise<void>;
}

export interface OverlayTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: OverlayTimers = {
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
};

/** Pure sync decision used by tests and the live bridge. */
export function overlaySyncPlan(
  dictation: DictationState,
  homeRecording = false,
): {
  visible: boolean;
  waveform: OverlayWaveform | null;
} {
  const waveform = overlayWaveformFromDictation(dictation);
  return {
    visible: isOverlayVisible(dictation.kind) || homeRecording,
    waveform: waveform ?? (homeRecording ? 'silent' : null),
  };
}

/**
 * Desktop overlay bridge (Tauri WebviewWindow). No-ops outside Tauri.
 * Never focuses the overlay window.
 */
export function createOverlayBridge(
  api?: OverlayWindowApi,
  timers: OverlayTimers = defaultTimers,
): OverlayBridge {
  const windowApi = api ?? createTauriOverlayApi();
  let lastWaveform: OverlayWaveform | null = null;
  let disposed = false;
  /** Pending hide timer of a result state; non-null while a result is shown. */
  let resultTimer: unknown = null;
  const clearResult = () => {
    if (resultTimer !== null) timers.clearTimeout(resultTimer);
    resultTimer = null;
  };
  const enqueue = (run: () => Promise<void>) => {
    syncChain = syncChain.then(run, run);
    return syncChain;
  };
  const hideNow = async (gen: number) => {
    await windowApi.hide();
    if (gen !== syncGeneration) return;
    lastWaveform = null;
  };
  const show = async (gen: number, placement: OverlayPlacement, cancellable = true) => {
    // Native cancellation/delivery may hide independently of this cache.
    // Reassert visibility; never focus the window.
    if (cancellable) await windowApi.showBottomCenter(placement);
    else await windowApi.showBottomCenter(placement, false);
    if (gen !== syncGeneration) return;
  };
  /** Serialize show/hide so a late show cannot outrun a newer hide. */
  let syncGeneration = 0;
  let syncChain: Promise<void> = Promise.resolve();

  return {
    async dispose() {
      disposed = true;
      clearResult();
      syncGeneration += 1;
      try {
        await windowApi.hide();
      } catch {
        // ignore
      }
    },
    async sync(dictation, homeRecording = false, cancellable = true) {
      if (disposed || !windowApi.isAvailable()) return;
      const plan = overlaySyncPlan(dictation, homeRecording);
      // A result state owns the HUD until its timer hides it.
      if (!plan.visible && resultTimer !== null) return;
      if (plan.visible) clearResult();
      const gen = ++syncGeneration;
      const run = async () => {
        if (disposed || gen !== syncGeneration) return;
        try {
          await windowApi.ensureCreated();
          if (disposed || gen !== syncGeneration) return;
          if (plan.visible) {
            if (plan.waveform && plan.waveform !== lastWaveform) {
              await windowApi.setWaveform(plan.waveform);
              if (gen !== syncGeneration) return;
              lastWaveform = plan.waveform;
            }
            await show(gen, OVERLAY_LISTEN_PLACEMENT, cancellable);
          } else {
            // Always hide when not visible so a raced late show cannot stick.
            await hideNow(gen);
          }
        } catch {
          // Overlay must never break dictation; failures are non-fatal.
        }
      };
      await enqueue(run);
    },
    async showResult(result) {
      if (disposed || !windowApi.isAvailable()) return;
      clearResult();
      const gen = ++syncGeneration;
      resultTimer = timers.setTimeout(() => {
        resultTimer = null;
        if (disposed || gen !== syncGeneration) return;
        const hideGen = ++syncGeneration;
        void enqueue(async () => {
          try { await hideNow(hideGen); } catch { /* non-fatal */ }
        });
      }, RESULT_HOLD_MS[result]);
      await enqueue(async () => {
        if (disposed || gen !== syncGeneration) return;
        try {
          await windowApi.ensureCreated();
          const waveform = resultWaveform(result);
          await windowApi.setWaveform(waveform, result);
          if (gen !== syncGeneration) return;
          lastWaveform = waveform;
          await show(gen, OVERLAY_RESULT_PLACEMENT, false);
        } catch {
          // non-fatal
        }
      });
    },
  };
}

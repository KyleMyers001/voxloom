import { isTauri } from "@tauri-apps/api/core";
import type { DictationState } from "../../domain/types";
import {
  OVERLAY_BOTTOM_MARGIN,
  OVERLAY_HEIGHT,
  OVERLAY_WINDOW_LABEL,
  OVERLAY_WIDTH,
} from "./constants";
import {
  isOverlayVisible,
  overlayWaveformFromDictation,
  type OverlayWaveform,
} from "./overlayVisibility";

export interface OverlayBridge {
  dispose(): Promise<void>;
  sync(dictation: DictationState, homeRecording?: boolean): Promise<void>;
}

export interface OverlayWindowApi {
  ensureCreated(): Promise<void>;
  hide(): Promise<void>;
  isAvailable(): boolean;
  setWaveform(waveform: OverlayWaveform): Promise<void>;
  showBottomCenter(): Promise<void>;
}

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
    waveform: waveform ?? (homeRecording ? "silent" : null),
  };
}

/**
 * Desktop overlay bridge (Tauri WebviewWindow). No-ops outside Tauri.
 * Never focuses the overlay window.
 */
export function createOverlayBridge(
  api?: OverlayWindowApi,
): OverlayBridge {
  const windowApi = api ?? createTauriOverlayApi();
  let lastVisible: boolean | null = null;
  let lastWaveform: OverlayWaveform | null = null;
  let disposed = false;
  /** Serialize show/hide so a late show cannot outrun a newer hide. */
  let syncGeneration = 0;
  let syncChain: Promise<void> = Promise.resolve();

  return {
    async dispose() {
      disposed = true;
      syncGeneration += 1;
      try {
        await windowApi.hide();
      } catch {
        // ignore
      }
    },
    async sync(dictation, homeRecording = false) {
      if (disposed || !windowApi.isAvailable()) return;
      const plan = overlaySyncPlan(dictation, homeRecording);
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
            if (lastVisible !== true) {
              await windowApi.showBottomCenter();
              if (gen !== syncGeneration) return;
              lastVisible = true;
            }
          } else {
            // Always hide when not visible so a raced late show cannot stick.
            await windowApi.hide();
            if (gen !== syncGeneration) return;
            lastVisible = false;
            lastWaveform = null;
          }
        } catch {
          // Overlay must never break dictation; failures are non-fatal.
        }
      };
      syncChain = syncChain.then(run, run);
      await syncChain;
    },
  };
}

function createTauriOverlayApi(): OverlayWindowApi {
  let created = false;

  return {
    isAvailable: () => isTauri(),
    async ensureCreated() {
      if (created) return;
      if (!isTauri()) return;
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("overlay_ensure", {
        height: OVERLAY_HEIGHT,
        label: OVERLAY_WINDOW_LABEL,
        marginBottom: OVERLAY_BOTTOM_MARGIN,
        width: OVERLAY_WIDTH,
      });
      created = true;
    },
    async hide() {
      if (!isTauri()) return;
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("overlay_hide", { label: OVERLAY_WINDOW_LABEL });
    },
    async setWaveform(waveform) {
      if (!isTauri()) return;
      const { emit } = await import("@tauri-apps/api/event");
      await emit("overlay:waveform", { waveform });
    },
    async showBottomCenter() {
      if (!isTauri()) return;
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("overlay_show", {
        height: OVERLAY_HEIGHT,
        label: OVERLAY_WINDOW_LABEL,
        marginBottom: OVERLAY_BOTTOM_MARGIN,
        width: OVERLAY_WIDTH,
      });
    },
  };
}

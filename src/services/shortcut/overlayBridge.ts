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
  sync(dictation: DictationState): Promise<void>;
}

export interface OverlayWindowApi {
  ensureCreated(): Promise<void>;
  hide(): Promise<void>;
  isAvailable(): boolean;
  setWaveform(waveform: OverlayWaveform): Promise<void>;
  showBottomCenter(): Promise<void>;
}

/** Pure sync decision used by tests and the live bridge. */
export function overlaySyncPlan(dictation: DictationState): {
  visible: boolean;
  waveform: OverlayWaveform | null;
} {
  const waveform = overlayWaveformFromDictation(dictation);
  return {
    visible: isOverlayVisible(dictation.kind),
    waveform,
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

  return {
    async dispose() {
      disposed = true;
      try {
        await windowApi.hide();
      } catch {
        // ignore
      }
    },
    async sync(dictation) {
      if (disposed || !windowApi.isAvailable()) return;
      const plan = overlaySyncPlan(dictation);
      try {
        await windowApi.ensureCreated();
        if (plan.visible) {
          if (plan.waveform && plan.waveform !== lastWaveform) {
            await windowApi.setWaveform(plan.waveform);
            lastWaveform = plan.waveform;
          }
          if (lastVisible !== true) {
            await windowApi.showBottomCenter();
            lastVisible = true;
          }
        } else if (lastVisible !== false) {
          await windowApi.hide();
          lastVisible = false;
          lastWaveform = null;
        }
      } catch {
        // Overlay must never break dictation; failures are non-fatal.
      }
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

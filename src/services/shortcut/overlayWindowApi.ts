import { isTauri } from '@tauri-apps/api/core';
import { OVERLAY_BOTTOM_MARGIN, OVERLAY_HEIGHT, OVERLAY_WIDTH, OVERLAY_WINDOW_LABEL } from './constants';
import type { OverlayWindowApi } from './overlayBridge';

/** Live overlay window (Tauri WebviewWindow). Never focuses it. */
export function createTauriOverlayApi(): OverlayWindowApi {
  let created = false;

  return {
    isAvailable: () => isTauri(),
    async ensureCreated() {
      if (created) return;
      if (!isTauri()) return;
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('overlay_ensure', {
        height: OVERLAY_HEIGHT,
        label: OVERLAY_WINDOW_LABEL,
        marginBottom: OVERLAY_BOTTOM_MARGIN,
        width: OVERLAY_WIDTH,
      });
      created = true;
    },
    async hide() {
      if (!isTauri()) return;
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('overlay_hide', { label: OVERLAY_WINDOW_LABEL });
    },
    async setWaveform(waveform, result) {
      if (!isTauri()) return;
      const { emit } = await import('@tauri-apps/api/event');
      await emit('overlay:waveform', { result, waveform });
    },
    async showBottomCenter(size = { height: OVERLAY_HEIGHT, width: OVERLAY_WIDTH }, cancellable = true) {
      if (!isTauri()) return;
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('overlay_show', {
        cancellable,
        height: size.height,
        label: OVERLAY_WINDOW_LABEL,
        marginBottom: OVERLAY_BOTTOM_MARGIN,
        width: size.width,
      });
    },
  };
}

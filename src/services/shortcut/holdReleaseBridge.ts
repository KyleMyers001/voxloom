import { isTauri } from "@tauri-apps/api/core";

export const HOLD_RELEASE_EVENT = "shortcut:hold-release";

export interface HoldReleaseApi {
  arm(pluginHotkey: string): Promise<void>;
  disarm(): Promise<void>;
  isAvailable(): boolean;
  /**
   * Subscribe to synthetic Released when Mac hold-release watch fires.
   * Returns an unsubscribe function.
   */
  listen(onRelease: () => void): Promise<() => void>;
}

/** Lazy Tauri bridge for macOS hold-release escalation; no-op elsewhere. */
export function createTauriHoldReleaseApi(): HoldReleaseApi {
  return {
    isAvailable: () => isTauri(),
    async arm(pluginHotkey) {
      if (!isTauri()) return;
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("hold_release_arm", { hotkey: pluginHotkey });
    },
    async disarm() {
      if (!isTauri()) return;
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("hold_release_disarm");
    },
    async listen(onRelease) {
      if (!isTauri()) return () => undefined;
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen(HOLD_RELEASE_EVENT, () => {
        onRelease();
      });
      return () => {
        unlisten();
      };
    },
  };
}

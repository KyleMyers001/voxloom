import { isTauri } from "@tauri-apps/api/core";

export const HOLD_RELEASE_EVENT = "shortcut:hold-release";

export interface HoldReleaseApi {
  /**
   * Arm Mac hold-release monitor. Resolves `true` when a real monitor owns
   * finish (ignore spurious OS Released); `false` when OS Released remains
   * authoritative (non-macOS stub / unavailable).
   */
  arm(pluginHotkey: string): Promise<boolean>;
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
      if (!isTauri()) return false;
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<boolean>("hold_release_arm", {
        hotkey: pluginHotkey,
      });
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

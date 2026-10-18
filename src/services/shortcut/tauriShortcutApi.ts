import { isTauri } from '@tauri-apps/api/core';

export interface NativeShortcutApi {
  isAvailable(): boolean;
  register(
    hotkey: string,
    onEdge: (edge: 'pressed' | 'released') => void,
  ): Promise<void>;
  unregister(hotkey: string): Promise<void>;
  unregisterAll(): Promise<void>;
}

/** Lazy-load Tauri plugin; no-op outside the desktop shell. */
export function createTauriShortcutApi(): NativeShortcutApi {
  return {
    isAvailable: () => isTauri(),
    async register(hotkey, onEdge) {
      const { register } = await import('@tauri-apps/plugin-global-shortcut');
      await register(hotkey, (event) => {
        if (event.state === 'Pressed') onEdge('pressed');
        else if (event.state === 'Released') onEdge('released');
      });
    },
    async unregister(hotkey) {
      const { unregister } = await import(
        '@tauri-apps/plugin-global-shortcut'
      );
      await unregister(hotkey);
    },
    async unregisterAll() {
      const { unregisterAll } = await import(
        '@tauri-apps/plugin-global-shortcut'
      );
      await unregisterAll();
    },
  };
}

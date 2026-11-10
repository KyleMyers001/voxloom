import { isTauri } from '@tauri-apps/api/core';

/** Sent by the native lone-key listener (src-tauri/src/lone_key/commands.rs). */
export const LONE_KEY_EVENT = 'shortcut:lone-key';

export type LoneKeyEdge = 'pressed' | 'released' | 'cancelled';

export interface LoneKeyApi {
  /** Listen for this lone key (a stored token such as "AltRight"). */
  arm(token: string): Promise<void>;
  /**
   * Ask macOS for Accessibility when it is not granted. It shows a system
   * prompt while access is missing, so call it only on a user action.
   * Resolves to whether access is granted right now (a first request usually
   * answers later: false).
   */
  requestAccess(): Promise<boolean>;
  /** Stop listening; fine when nothing is armed. */
  disarm(): Promise<void>;
  /** Subscribe to edges. Returns an unsubscribe function. */
  listen(onEdge: (edge: LoneKeyEdge) => void): Promise<() => void>;
}

const EDGES: readonly string[] = ['pressed', 'released', 'cancelled'];

const asError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)));

/** Lazy Tauri bridge for a lone key as the shortcut; no-op outside the desktop shell. */
export function createTauriLoneKeyApi(): LoneKeyApi {
  return {
    async arm(token) {
      const { invoke } = await import('@tauri-apps/api/core');
      try {
        await invoke('lone_key_arm', { token });
      } catch (err) {
        throw asError(err);
      }
    },
    async requestAccess() {
      if (!isTauri()) return false;
      const { invoke } = await import('@tauri-apps/api/core');
      try {
        return (await invoke<boolean>('lone_key_request_access')) === true;
      } catch {
        return false; // arm reports the refusal in words
      }
    },
    async disarm() {
      if (!isTauri()) return;
      const { invoke } = await import('@tauri-apps/api/core');
      try {
        await invoke('lone_key_disarm');
      } catch (err) {
        throw asError(err);
      }
    },
    async listen(onEdge) {
      if (!isTauri()) return () => undefined;
      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen<string>(LONE_KEY_EVENT, (event) => {
        if (EDGES.includes(event.payload)) onEdge(event.payload as LoneKeyEdge);
      });
      return () => {
        unlisten();
      };
    },
  };
}

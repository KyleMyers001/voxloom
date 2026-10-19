import { isTauri, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface CancelScope {
  /** Atomically stop accepting Escape before any delivery side effect. */
  finish(): Promise<boolean>;
  dispose(): Promise<void>;
}

/** A session-scoped native tap, never a permanent global Escape shortcut. */
export async function beginCancelScope(
  onCancel: () => void,
  isCurrent: () => boolean = () => true,
): Promise<CancelScope> {
  if (!isTauri()) return { finish: async () => true, dispose: async () => {} };
  const session = crypto.randomUUID();
  let closed = false;
  const unlisten = await listen<string>('dictation:cancel', ({ payload }) => {
    if (!closed && payload === session) onCancel();
  });
  const closeListener = () => { if (!closed) { closed = true; unlisten(); } };
  // Listener registration can resolve out of order across cancel/restart.
  // Never dispatch an obsolete arm: native arm replaces the current tap.
  if (!isCurrent()) {
    closeListener();
    return { finish: async () => false, dispose: async () => {} };
  }
  try {
    await invoke('dictation_cancel_arm', { session });
  } catch (error) {
    closeListener();
    throw error;
  }
  return {
    async finish() {
      if (closed) return false;
      try { return await invoke<boolean>('dictation_cancel_finish', { session }); }
      catch (error) {
        await invoke('dictation_cancel_end', { session }).catch(() => {});
        throw error;
      }
      finally { closeListener(); }
    },
    async dispose() {
      if (closed) return;
      closeListener();
      await invoke('dictation_cancel_end', { session });
    },
  };
}

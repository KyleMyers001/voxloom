/**
 * BUS-35: the backend emits `stt:models-changed` after its one-time startup
 * check of each model file on disk, so Settings → Models re-lists and a
 * damaged or unreadable file shows as failed with Retry right away.
 */
import { isTauri } from '@tauri-apps/api/core';

export const MODELS_CHANGED_EVENT = 'stt:models-changed';

export async function listenModelsChanged(handler: () => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen(MODELS_CHANGED_EVENT, () => handler());
}

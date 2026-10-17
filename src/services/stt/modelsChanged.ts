/**
 * BUS-77: the backend emits `stt:models-changed` when its startup hash finds
 * a damaged model file, so Settings → Models re-lists instead of showing the
 * row as available until the next refresh.
 */
import { isTauri } from '@tauri-apps/api/core';

export const MODELS_CHANGED_EVENT = 'stt:models-changed';

export async function listenModelsChanged(handler: () => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen(MODELS_CHANGED_EVENT, () => handler());
}

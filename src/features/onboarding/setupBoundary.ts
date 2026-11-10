import { invoke, isTauri } from '@tauri-apps/api/core';
import { getActiveShortcut } from '../../services/shortcut/activeShortcut';
import { createWhisperSttModelStore } from '../../services/stt/whisperAdapter';
import type { SetupBoundary } from './guidedSetup';

/** Browser is unsupported, not a simulated successful setup. No constructors prompt/download. */
export function createSetupBoundary(): SetupBoundary {
  const store = createWhisperSttModelStore();
  const unsupported = async (): Promise<never> => { throw new Error('Real guided setup requires the macOS desktop app.'); };
  return {
    native: isTauri(),
    activeShortcut: getActiveShortcut,
    query: () => isTauri() ? invoke('setup_query_permissions') : Promise.resolve({ microphone: 'unsupported', accessibility: 'unsupported', inputMonitoring: 'unsupported' }),
    request: (kind) => isTauri() ? invoke('setup_request_permission', { kind }) : unsupported(),
    openSettings: (kind) => isTauri() ? invoke('setup_open_permission_settings', { kind }) : unsupported(),
    readiness: (modelId) => isTauri() ? invoke('setup_model_readiness', { modelId }) : Promise.resolve({ modelId, ready: false, reason: 'Real dictation practice requires the macOS desktop app.' }),
    modelStatus: (modelId) => isTauri() ? store.status(modelId) : Promise.resolve(null),
    download: (id, progress) => store.download(id, progress),
    cancelDownload: (id) => store.cancel(id),
  };
}

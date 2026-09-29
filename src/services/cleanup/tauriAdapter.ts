import { invoke } from '@tauri-apps/api/core';
import type {
  CleanupEngine,
  CleanupModelStore,
} from './contracts';
import type {
  CleanupModelStatus,
} from './types';

export function createTauriCleanupEngine(): CleanupEngine {
  return {
    async cancel(requestId) {
      await invoke('cleanup_cancel', { requestId });
    },
    async run(request) {
      return invoke<string>('cleanup_run', { request });
    },
  };
}

export function createTauriCleanupModelStore(): CleanupModelStore {
  return {
    async importModel() {
      return invoke<CleanupModelStatus | null>(
        'cleanup_pick_and_import_model',
      );
    },
    async status() {
      return invoke<CleanupModelStatus>('cleanup_model_status');
    },
  };
}

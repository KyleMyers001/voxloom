import { invoke } from '@tauri-apps/api/core';
import type {
  CleanupEngine,
  CleanupModelStore,
} from './contracts';
import type {
  CleanupModelStatus,
} from './types';
import { CleanupEngineError, type CleanupReason } from './types';

interface NativeCleanupError {
  code?: unknown;
  message?: unknown;
}

function runtimeError(error: unknown): CleanupEngineError {
  const native = error as NativeCleanupError | null;
  const code = typeof native?.code === 'string'
    ? native.code as CleanupReason
    : 'runtime-error';
  const message = typeof native?.message === 'string'
    ? native.message
    : String(error);
  return new CleanupEngineError(code, message);
}

export function createTauriCleanupEngine(): CleanupEngine {
  return {
    async acquire(requestId, modelId) {
      try {
        await invoke('cleanup_acquire', { modelId, requestId });
      } catch (error: unknown) {
        throw runtimeError(error);
      }
    },
    async cancel(requestId) {
      await invoke('cleanup_cancel', { requestId });
    },
    async release(requestId) {
      await invoke('cleanup_release', { requestId });
    },
    async run(request) {
      try {
        return await invoke<string>('cleanup_run', { request });
      } catch (error: unknown) {
        throw runtimeError(error);
      }
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

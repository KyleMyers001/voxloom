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
  let session: Promise<string> | null = null;
  let disposed = false;
  let disposal: Promise<void> | null = null;
  const acquisitions = new Map<string, Promise<void>>();

  async function sessionId(): Promise<string> {
    if (disposed) throw new CleanupEngineError('cancelled', 'Cleanup session disposed');
    const opening = session ??= invoke<string>('cleanup_session_open');
    let id: string;
    try {
      id = await opening;
    } catch (error: unknown) {
      if (session === opening) session = null;
      throw error;
    }
    if (disposed) throw new CleanupEngineError('cancelled', 'Cleanup session disposed');
    return id;
  }

  async function ownedInvoke<T>(
    command: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    try {
      const owner = await sessionId();
      return await invoke<T>(command, { ...args, sessionId: owner });
    } catch (error: unknown) {
      throw runtimeError(error);
    }
  }

  async function settle(command: string, requestId: string): Promise<void> {
    if (!session || disposed) return;
    // Do not let release overtake an acquire still opening its descriptor.
    // Native generations independently protect disposal/navigation races.
    try {
      await acquisitions.get(requestId);
    } catch {
      // Still settle failures if the session itself was established.
    }
    if (session !== null && !disposed) {
      await ownedInvoke(command, { requestId });
    }
  }

  return {
    async acquire(requestId, modelId) {
      const acquiring = ownedInvoke<void>(
        'cleanup_acquire', { modelId, requestId },
      );
      acquisitions.set(requestId, acquiring);
      try {
        await acquiring;
      } finally {
        if (acquisitions.get(requestId) === acquiring) {
          acquisitions.delete(requestId);
        }
      }
    },
    cancel: (requestId) => settle('cleanup_cancel', requestId),
    release: (requestId) => settle('cleanup_release', requestId),
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      const opening = session;
      disposal = (async () => {
        if (!opening) return;
        let owner: string;
        try {
          owner = await opening;
        } catch {
          return;
        }
        await invoke('cleanup_session_dispose', { sessionId: owner });
      })();
      return disposal;
    },
    run: (request) => ownedInvoke<string>('cleanup_run', { request }),
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

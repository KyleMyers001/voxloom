import { Channel, invoke } from '@tauri-apps/api/core';
import type {
  CleanupEngine,
  CleanupModelStore,
} from './contracts';
import type {
  CleanupAttempt,
  CleanupModelStatus,
  CleanupResult,
} from './types';
import {
  CLEANUP_MODEL_ID, CLEANUP_MODEL_SHA256, CLEANUP_REASONS,
  CleanupEngineError, type CleanupReason,
} from './types';

interface NativeCleanupError {
  attempt?: unknown;
  code?: unknown;
  message?: unknown;
}

function parseAttempt(value: unknown): CleanupAttempt | undefined {
  const candidate = value as Partial<CleanupAttempt> | null;
  return candidate?.modelId === CLEANUP_MODEL_ID
    && candidate.modelDigest === CLEANUP_MODEL_SHA256
    ? { modelId: candidate.modelId, modelDigest: candidate.modelDigest } : undefined;
}

function runtimeError(error: unknown): CleanupEngineError {
  const native = error as NativeCleanupError | null;
  const code = typeof native?.code === 'string'
    && CLEANUP_REASONS.includes(native.code as CleanupReason)
    ? native.code as CleanupReason
    : 'runtime-error';
  const message = typeof native?.message === 'string'
    ? native.message
    : String(error);
  return new CleanupEngineError(code, message, parseAttempt(native?.attempt));
}

export function createTauriCleanupEngine(): CleanupEngine {
  let session: Promise<string> | null = null;
  let disposed = false;
  let disposal: Promise<void> | null = null;
  const acquisitions = new Map<string, Promise<void>>();
  const runs = new Map<string, Promise<CleanupResult>>();

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
      const running = runs.get(requestId);
      await ownedInvoke(command, { requestId });
      // Native cancellation waits for reaping. Also drain the result so the
      // final attempt evidence can arrive. This can hang with a wedged worker,
      // so callers never await it unbounded: runCleanup waits at most
      // CANCEL_GRACE_MS, and release is fire-and-forget.
      await running?.catch(() => {});
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
    run(request, onStarted) {
      if (disposed) return Promise.reject(new CleanupEngineError('cancelled', 'Cleanup session disposed'));
      if (runs.has(request.requestId)) {
        return Promise.reject(new CleanupEngineError('runtime-error', 'Cleanup request already running'));
      }
      const running = (async (): Promise<CleanupResult> => {
        // A channel registers a JS callback. Allocate only once a native owner
        // exists, so a failed/retired handshake cannot strand that callback.
        const owner = await sessionId();
        let live = true;
        let notified = false;
        const channel = new Channel<unknown>();
        channel.onmessage = (value) => {
          const attempt = parseAttempt(value);
          if (live && !disposed && !notified && attempt?.modelId === request.modelId) {
            notified = true;
            onStarted?.(attempt);
          }
        };
        try {
          const output = await invoke<{ attempt?: unknown; text?: unknown } | null>(
            'cleanup_run', { onStarted: channel, request, sessionId: owner },
          );
          const attempt = parseAttempt(output?.attempt);
          if (!attempt || attempt.modelId !== request.modelId || typeof output?.text !== 'string') {
            throw new CleanupEngineError('runtime-error', 'Malformed cleanup result');
          }
          return { attempt, text: output.text };
        } finally {
          live = false;
        }
      })().catch((error: unknown) => { throw runtimeError(error); });
      runs.set(request.requestId, running);
      const settled = () => { runs.delete(request.requestId); };
      void running.then(settled, settled);
      return running;
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

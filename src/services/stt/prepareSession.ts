import { invoke, isTauri } from '@tauri-apps/api/core';
import { mapNativeError } from './whisperAdapter';

export interface PreparedSttSession {
  readonly requestId: string;
  /** Fast admission only, never model readiness. */
  readonly admission: Promise<void>;
  cancel(): Promise<void>;
  /** Final stopped-PCM disposal, independent of admission or prior retirement. */
  release(bufferId?: string): Promise<void>;
}

export function prepareSttSession(modelId: string): PreparedSttSession | undefined {
  if (!['parakeet-tdt-0.6b-v2', 'parakeet-tdt-0.6b-v3'].includes(modelId) || !isTauri()) return undefined;
  const requestId = `stt-${crypto.randomUUID()}`;
  const admission = invoke<void>('stt_prepare', { modelId, requestId }).catch((error: unknown) => {
    throw mapNativeError(error);
  });
  let retirement: Promise<void> | undefined;
  const retire = (command: string) => retirement ??= admission.then(async () => {
    await invoke(command, { requestId });
  });
  return {
    requestId,
    admission,
    cancel: () => retire('stt_cancel'),
    release: (bufferId) => bufferId === undefined
      ? retire('stt_release')
      // Native disposal is idempotent, including after transcribe consumed PCM.
      // Do not join admission or memoized cancel: either may have already failed.
      : invoke<void>('stt_release', { requestId, bufferId }),
  };
}

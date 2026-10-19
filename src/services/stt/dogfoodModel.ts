/// Model checks and user-facing error text for the dogfood capture path.
/// Never silent-downloads missing models — surfaces a clear UI error instead.

import type { SttModelStore } from './contracts';
import { resolveTranscriptionModelId } from './resolveModelId';
import { SttError, type SttModelInfo } from './types';
import { MODEL_UNREADABLE } from './useSttModels';

/** Same wording as the Models row (ModelCard), plus where to fix it. */
export const MODEL_DAMAGED_MESSAGE = 'Model file is damaged. Download it again in Settings.';

/** Opened but couldn't be read: the row's copy plus where to fix it. */
export const MODEL_READ_FAILED_MESSAGE = 'Couldn\'t read the model file. Download it again in Settings.';

/** Model-file messages (here and native resolved_path) that already say what to do. */
const MODEL_FILE_PREFIXES = [
  'Model file is damaged.',
  'Couldn\'t open the model file.',
  'Couldn\'t read the model file.',
];

function failedModelMessage(reason: SttModelInfo['failureReason']): string {
  if (reason === 'unreadable') return MODEL_UNREADABLE;
  if (reason === 'read-failed') return MODEL_READ_FAILED_MESSAGE;
  return MODEL_DAMAGED_MESSAGE;
}

export function errorText(error: unknown): string {
  if (error instanceof SttError) {
    if (error.code === 'model-missing') {
      if (MODEL_FILE_PREFIXES.some((p) => error.message.startsWith(p))) return error.message;
      // Settings guidance lives here once; missingModelMessage is the fact only.
      return `${error.message} Download the selected model in Settings first.`;
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function missingModelMessage(modelId: string, status: string | null): string {
  const detail = status ? ` (status: ${status})` : '';
  // Fact only — errorText appends the short Settings suffix once.
  return `Model “${modelId}” is not downloaded${detail}.`;
}

/** Resolves the model id, or throws `model-missing` unless it is available. */
export async function ensureModelAvailable(
  store: SttModelStore,
  rawModelId: string,
): Promise<string> {
  const modelId = resolveTranscriptionModelId(rawModelId);
  const info = await store.status(modelId);
  if (info?.status === 'failed') {
    throw new SttError('model-missing', failedModelMessage(info.failureReason));
  }
  if (!info || info.status !== 'available') {
    throw new SttError(
      'model-missing',
      missingModelMessage(modelId, info?.status ?? null),
    );
  }
  return modelId;
}

/// Small steps of the dogfood path (split out of dogfoodPath.ts to keep it
/// short): the delivery adapter and the guarded cleanup call.

import type { CleanupOutcome } from '../cleanup/types';
import type { ClipboardAdapter } from '../clipboard';
import {
  createStubDeliveryAdapter,
  createTauriDeliveryAdapter,
  type DeliveryPlatformAdapter,
} from '../delivery';
import type { Transcript } from './types';

export function resolvePlatform(
  clipboard: ClipboardAdapter,
  injected?: DeliveryPlatformAdapter,
): DeliveryPlatformAdapter {
  if (injected) return injected;
  try {
    return createTauriDeliveryAdapter(clipboard);
  } catch {
    return createStubDeliveryAdapter({ clipboard });
  }
}

export async function cleanUp(
  options: {
    cleanup?: (text: string) => Promise<CleanupOutcome>;
    isCurrent?: () => boolean;
  },
  transcript: Transcript,
): Promise<CleanupOutcome | undefined> {
  if (!options.cleanup || !transcript.text.trim()) return undefined;
  if (!(options.isCurrent?.() ?? true)) return undefined;
  try {
    return await options.cleanup(transcript.text);
  } catch {
    // The stage must not throw; if it does, deliver the raw transcript.
    return { finalText: transcript.text, reason: 'runtime-error', status: 'fallback' };
  }
}

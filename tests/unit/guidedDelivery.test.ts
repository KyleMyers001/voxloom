import { expect, it, vi } from 'vitest';
import { dogfoodTranscribeAndCopy } from '../../src/services/stt/dogfoodPath';
import { createStubDeliveryAdapter } from '../../src/services/delivery/stubAdapter';

it('practice never falls through to clipboard or an outside destination when its owned note is not focused', async () => {
  const clipboard = { copy: vi.fn() };
  const platform = createStubDeliveryAdapter({ clipboard });
  const snapshot = vi.spyOn(platform, 'snapshotTarget');
  const result = await dogfoodTranscribeAndCopy({
    audio: { id: 'opaque-test-pcm', duration_ms: 1400, sample_rate_hz: 16000 },
    clipboard,
    modelId: 'whisper-base.en',
    createEngine: () => ({ modelId: 'whisper-base.en', transcribe: async () => ({ text: 'Synthetic boundary fixture only' }) }),
    insertOwnField: () => false,
    onlyOwnField: true,
    deliveryPlatform: platform,
  });
  expect(result.delivery.status).toBe('failed');
  expect(clipboard.copy).not.toHaveBeenCalled();
  expect(snapshot).not.toHaveBeenCalled();
});

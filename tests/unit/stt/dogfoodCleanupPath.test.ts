// @vitest-environment node
// BUS-16 PR 2c: optional cleanup sits between STT and delivery, and never
// loses the dictation.
import { describe, expect, it, vi } from 'vitest';
import type { CleanupOutcome } from '../../../src/services/cleanup/types';
import type { ClipboardAdapter } from '../../../src/services/clipboard';
import { dogfoodTranscribeAndCopy } from '../../../src/services/stt/dogfoodPath';
import { createMockSttEngine } from '../../../src/services/stt/mockStt';

function clipboard(): ClipboardAdapter {
  return { copy: vi.fn().mockResolvedValue(undefined) };
}

function run(cleanup?: (text: string) => Promise<CleanupOutcome>, isCurrent?: () => boolean) {
  const clip = clipboard();
  const beforeDelivery = vi.fn().mockResolvedValue(undefined);
  const result = dogfoodTranscribeAndCopy({
    audio: { duration_ms: 900, id: 'pcm-c', sample_rate_hz: 16_000 },
    beforeDelivery,
    cleanup,
    clipboard: clip,
    createEngine: (modelId) => createMockSttEngine({ modelId, transcriptText: 'um send it' }),
    isCurrent,
    modelId: 'whisper-tiny.en',
  });
  return { beforeDelivery, clip, result };
}

describe('dogfood path with cleanup', () => {
  it('delivers cleaned text and keeps the engine output as rawText', async () => {
    const cleanup = vi.fn(async (): Promise<CleanupOutcome> => ({ finalText: 'Send it.', status: 'cleaned' }));
    const { clip, result } = run(cleanup);
    const done = await result;
    expect(cleanup).toHaveBeenCalledWith('um send it');
    expect(clip.copy).toHaveBeenCalledWith('Send it.');
    expect(done.transcript).toMatchObject({ rawText: 'um send it', text: 'Send it.' });
    expect(done.cleanup?.status).toBe('cleaned');
  });

  it('delivers the raw text on fallback', async () => {
    const { clip, result } = run(async () => ({
      finalText: 'um send it', reason: 'invalid-output', status: 'fallback',
    }));
    const done = await result;
    expect(clip.copy).toHaveBeenCalledWith('um send it');
    expect(done.transcript.text).toBe('um send it');
    expect(done.cleanup).toMatchObject({ reason: 'invalid-output', status: 'fallback' });
  });

  it('delivers the raw text if the stage throws', async () => {
    const { clip, result } = run(async () => { throw new Error('bug'); });
    const done = await result;
    expect(clip.copy).toHaveBeenCalledWith('um send it');
    expect(done.cleanup).toMatchObject({ reason: 'runtime-error', status: 'fallback' });
  });

  it('a user cancel during cleanup delivers nothing', async () => {
    const { beforeDelivery, clip, result } = run(async () => ({ reason: 'cancelled', status: 'cancelled' }));
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(beforeDelivery).not.toHaveBeenCalled();
    expect(clip.copy).not.toHaveBeenCalled();
  });

  it('skips cleanup for a superseded session', async () => {
    const cleanup = vi.fn();
    const { clip, result } = run(cleanup, () => false);
    const done = await result;
    expect(cleanup).not.toHaveBeenCalled();
    expect(done.cleanup).toBeUndefined();
    expect(clip.copy).not.toHaveBeenCalled();
  });

  it('without a stage, behaves as before', async () => {
    const { clip, result } = run();
    const done = await result;
    expect(done.cleanup).toBeUndefined();
    expect(done.transcript.rawText).toBeUndefined();
    expect(clip.copy).toHaveBeenCalledWith('um send it');
  });
});

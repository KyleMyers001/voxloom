/** @vitest-environment jsdom */
// BUS-138 PR B: aliases reach the transcript on the dictation path, History
// keeps the engine output, and cleanup is never sent the aliases.
import { describe, expect, it, vi } from 'vitest';

import type { CleanupOutcome } from '../../../src/services/cleanup/types';
import type { DeliveryPlatformAdapter, TargetSnapshot } from '../../../src/services/delivery';
import { buildCleanupPrompt, snapshotDictionary } from '../../../src/services/cleanup/prompt';
import { dogfoodTranscribeAndCopy } from '../../../src/services/stt/dogfoodPath';
import { createMockSttEngine } from '../../../src/services/stt/mockStt';
import { withDictionary } from '../../../src/services/stt/dogfoodDictionary';

const SECURE: TargetSnapshot = {
  appName: 'Safari', appPid: 9, capturedAt: 1, elementId: '9:AXSecureTextField:',
  elementRole: 'AXSecureTextField', insertable: false, kind: 'secure',
  reason: 'secure field — insert skipped',
};
const WORDS = ['Voxloom', 'Postgres'];
const ALIASES = { Voxloom: ['box loom'] };
const HEARD = 'i pushed box loom to github';
const FIXED = 'i pushed Voxloom to github';

function platform(): DeliveryPlatformAdapter {
  return {
    clipboardRead: vi.fn(async () => ({ ok: true, text: '' })),
    clipboardRestore: vi.fn().mockResolvedValue(undefined),
    clipboardWrite: vi.fn().mockResolvedValue(undefined),
    insertText: vi.fn().mockResolvedValue(undefined),
    pasteBinding: vi.fn().mockResolvedValue(null),
    pasteText: vi.fn().mockResolvedValue({ clipboardRestored: true, restoreSkippedReason: null }),
    snapshotTarget: vi.fn().mockResolvedValue(SECURE),
    validateTarget: vi.fn().mockResolvedValue(SECURE),
  };
}

function run(options: {
  aliases?: Record<string, string[]>;
  cleanup?: (text: string) => Promise<CleanupOutcome>;
}) {
  const deliveryPlatform = platform();
  const result = dogfoodTranscribeAndCopy({
    audio: { duration_ms: 900, id: 'pcm-alias', sample_rate_hz: 16_000 },
    cleanup: options.cleanup,
    clipboard: { copy: vi.fn().mockResolvedValue(undefined) },
    createEngine: (modelId) => ({
      ...createMockSttEngine({ modelId }),
      transcribe: async () => ({ language: 'en', text: HEARD }),
    }),
    deliveryPlatform,
    dictionary: WORDS,
    dictionaryAliases: options.aliases,
    modelId: 'whisper-tiny.en',
  });
  return { deliveryPlatform, result };
}

describe('aliases on the dictation path', () => {
  it('delivers the canonical spelling and keeps the engine output as rawText', async () => {
    const { deliveryPlatform, result } = run({ aliases: ALIASES });
    const done = await result;
    expect(deliveryPlatform.clipboardWrite).toHaveBeenCalledWith(FIXED);
    expect(done.transcript.text).toBe(FIXED);
    expect(done.transcript.rawText).toBe(HEARD);
  });

  it('without aliases the text is unchanged, as in PR A', async () => {
    const { result } = run({});
    const done = await result;
    expect(done.transcript.text).toBe(HEARD);
    expect(done.transcript.rawText).toBeUndefined();
  });

  it('hands cleanup the canonical text and fixes cleaned text again', async () => {
    const cleanup = vi.fn(async (): Promise<CleanupOutcome> => ({
      finalText: 'I pushed box loom to GitHub.', status: 'cleaned',
    }));
    const { deliveryPlatform, result } = run({ aliases: ALIASES, cleanup });
    const done = await result;
    expect(cleanup).toHaveBeenCalledWith(FIXED);
    expect(deliveryPlatform.clipboardWrite).toHaveBeenCalledWith('I pushed Voxloom to GitHub.');
    expect(done.transcript.rawText).toBe(HEARD);
  });

  it('keeps the fix when cleanup falls back', async () => {
    const cleanup = async (text: string): Promise<CleanupOutcome> => ({
      finalText: text, reason: 'invalid-output', status: 'fallback',
    });
    const { result } = run({ aliases: ALIASES, cleanup });
    expect((await result).transcript.text).toBe(FIXED);
  });

  it('withDictionary returns the same object when nothing changed', () => {
    const transcript = { language: 'en', text: 'nothing here' };
    expect(withDictionary(transcript, WORDS, ALIASES)).toBe(transcript);
  });
});

describe('aliases are not part of the cleanup prompt', () => {
  it('the prompt carries only the words', () => {
    const prompt = buildCleanupPrompt({
      dictionary: snapshotDictionary(WORDS),
      rawText: FIXED,
      style: 'formal',
    });
    expect(prompt).toContain('Voxloom');
    expect(prompt).not.toContain('box loom');
  });
});

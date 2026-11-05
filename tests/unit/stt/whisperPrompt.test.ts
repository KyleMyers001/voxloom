// @vitest-environment node
// BUS-138 PR C: the user's dictionary words reach the native Whisper call, which
// turns them into the initial prompt. No words: the call is the same as before.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke, isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { dogfoodTranscribeAndCopy } from '../../../src/services/stt/dogfoodPath';
import { createMockSttEngine } from '../../../src/services/stt/mockStt';
import { createWhisperSttEngine } from '../../../src/services/stt/whisperAdapter';

const HANDLE = { durationMs: 100, id: 'pcm-1', sampleRateHz: 16_000 };

describe('native transcribe call', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue({ language: 'en', text: 'hello' });
  });

  it('sends the dictionary words when there are some', async () => {
    const engine = createWhisperSttEngine({ modelId: 'whisper-base.en' });
    await engine.transcribe(HANDLE, { dictionary: ['Voxloom', 'Notion'] });
    expect(mockInvoke).toHaveBeenCalledWith('stt_transcribe', {
      bufferId: 'pcm-1',
      dictionary: ['Voxloom', 'Notion'],
      filter: null,
      modelId: 'whisper-base.en',
    });
  });

  it.each([
    ['an empty dictionary', { dictionary: [] }],
    ['no dictionary', {}],
    ['no options', undefined],
  ])('sends exactly the old call for %s', async (_name, options) => {
    const engine = createWhisperSttEngine({ modelId: 'whisper-base.en' });
    await engine.transcribe(HANDLE, options);
    expect(mockInvoke).toHaveBeenCalledWith('stt_transcribe', {
      bufferId: 'pcm-1',
      filter: null,
      modelId: 'whisper-base.en',
    });
  });
});

describe('dictation', () => {
  function run(dictionary: readonly string[] | undefined) {
    const transcribe = vi.fn().mockResolvedValue({ language: 'en', text: 'hello' });
    const done = dogfoodTranscribeAndCopy({
      audio: { duration_ms: 100, id: 'pcm-2', sample_rate_hz: 16_000 },
      clipboard: { copy: vi.fn().mockResolvedValue(undefined) },
      createEngine: (modelId) => ({ ...createMockSttEngine({ modelId }), transcribe }),
      deliveryPlatform: {
        clipboardRead: vi.fn(async () => ({ ok: true, text: '' })),
        clipboardRestore: vi.fn().mockResolvedValue(undefined),
        clipboardWrite: vi.fn().mockResolvedValue(undefined),
        insertText: vi.fn().mockResolvedValue(undefined),
        pasteBinding: vi.fn().mockResolvedValue(null),
        pasteText: vi.fn().mockResolvedValue({ clipboardRestored: true, restoreSkippedReason: null }),
        snapshotTarget: vi.fn().mockResolvedValue(null),
        validateTarget: vi.fn().mockResolvedValue(null),
      },
      dictionary,
      modelId: 'whisper-tiny.en',
    });
    return { done, transcribe };
  }

  it('hands the engine the saved dictionary, newest added first', async () => {
    const { done, transcribe } = run(['Voxloom', 'Notion']);
    await done;
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pcm-2' }),
      { dictionary: ['Notion', 'Voxloom'] },
    );
  });

  it('keeps the newest entries first when the dictionary is large', async () => {
    const added = Array.from({ length: 400 }, (_, i) => `Term${String(i).padStart(3, '0')}`);
    const { done, transcribe } = run(added);
    await done;
    const sent = (transcribe.mock.calls[0][1] as { dictionary: string[] }).dictionary;
    expect(sent).toHaveLength(400);
    expect(sent.slice(0, 3)).toEqual(['Term399', 'Term398', 'Term397']);
    expect(sent.at(-1)).toBe('Term000');
  });

  it('hands the engine no words when the dictionary is empty', async () => {
    const { done, transcribe } = run([]);
    await done;
    expect(transcribe.mock.calls[0][1]).toEqual({ dictionary: [] });
  });
});

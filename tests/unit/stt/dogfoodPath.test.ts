// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { ClipboardAdapter } from '../../../src/services/clipboard';
import { dogfoodTranscribeAndCopy } from '../../../src/services/stt/dogfoodPath';
import { createMockSttEngine } from '../../../src/services/stt/mockStt';
import { CleanupEngineError } from '../../../src/services/cleanup';
import type { ProcessingSignal } from
  '../../../src/services/dictation/coordinator';

function clipboard(): ClipboardAdapter {
  return { copy: vi.fn().mockResolvedValue(undefined) };
}

function processingSignal(aborted = false): ProcessingSignal {
  return { aborted, onAbort: vi.fn() };
}

describe('dogfoodTranscribeAndCopy', () => {
  it('uses the selected modelId on the engine and copies transcript', async () => {
    const clip = clipboard();
    const createEngine = vi.fn((modelId: string) =>
      createMockSttEngine({
        modelId,
        transcriptText: `from ${modelId}`,
      }),
    );

    const result = await dogfoodTranscribeAndCopy({
      audio: {
        duration_ms: 1_200,
        id: 'pcm-1',
        sample_rate_hz: 16_000,
      },
      clipboard: clip,
      createEngine,
      modelId: 'whisper-base.en',
    });

    expect(createEngine).toHaveBeenCalledWith('whisper-base.en');
    expect(result.transcript.text).toBe('from whisper-base.en');
    expect(result.copied).toBe(true);
    expect(result.copyWarning).toBeUndefined();
    expect(result.delivery.status).toBe('copied');
    expect(result.delivery.message).toMatch(/^Copied/);
    expect(clip.copy).toHaveBeenCalledWith('from whisper-base.en');
  });

  it('soft-fails Copy: still returns transcript when clipboard throws', async () => {
    const clip: ClipboardAdapter = {
      copy: vi.fn().mockRejectedValue(new Error('NotAllowedError')),
    };
    const createEngine = vi.fn((modelId: string) =>
      createMockSttEngine({
        modelId,
        transcriptText: 'heard you',
      }),
    );

    const result = await dogfoodTranscribeAndCopy({
      audio: { duration_ms: 400, id: 'pcm-soft', sample_rate_hz: 16_000 },
      clipboard: clip,
      createEngine,
      modelId: 'whisper-tiny.en',
    });

    expect(result.transcript.text).toBe('heard you');
    expect(result.copied).toBe(false);
    expect(result.delivery.status).toBe('failed');
    expect(result.copyWarning).toMatch(/NotAllowedError|clipboard/i);
  });

  it('maps legacy simulated labels to the default model id', async () => {
    const createEngine = vi.fn((modelId: string) =>
      createMockSttEngine({ modelId }),
    );

    await dogfoodTranscribeAndCopy({
      audio: { duration_ms: 100, id: 'pcm-2', sample_rate_hz: 16_000 },
      clipboard: clipboard(),
      createEngine,
      modelId: 'Pine Voice Small · local',
    });

    expect(createEngine).toHaveBeenCalledWith('whisper-tiny.en');
  });

  it('never auto-downloads — only constructs an engine', async () => {
    const download = vi.fn();
    const createEngine = vi.fn((modelId: string) => {
      // Prove dogfood path does not touch a model store download.
      expect(download).not.toHaveBeenCalled();
      return createMockSttEngine({ modelId });
    });

    await dogfoodTranscribeAndCopy({
      audio: { duration_ms: 50, id: 'pcm-3', sample_rate_hz: 16_000 },
      clipboard: clipboard(),
      createEngine,
      modelId: 'whisper-tiny.en',
    });

    expect(download).not.toHaveBeenCalled();
    expect(createEngine).toHaveBeenCalledOnce();
  });
});

describe('dogfoodTranscribeAndCopy delivery (BUS-14)', () => {
  it('reports Inserted when injected platform insert succeeds', async () => {
    const clip = clipboard();
    const insertText = vi.fn().mockResolvedValue(undefined);
    const intended = {
      appName: 'Notes',
      appPid: 7,
      capturedAt: 1,
      elementId: '7:AXTextArea:',
      elementRole: 'AXTextArea',
      insertable: true,
      kind: 'insertable' as const,
      reason: null,
    };
    const deliveryPlatform = {
      clipboardRead: vi.fn().mockResolvedValue({ ok: true, text: '' }),
      clipboardRestore: vi.fn(),
      clipboardWrite: vi.fn(),
      insertText,
      snapshotTarget: vi.fn().mockResolvedValue(intended),
      validateTarget: vi.fn().mockResolvedValue(intended),
    };

    const result = await dogfoodTranscribeAndCopy({
      audio: { duration_ms: 200, id: 'pcm-ins', sample_rate_hz: 16_000 },
      clipboard: clip,
      createEngine: (modelId) =>
        createMockSttEngine({ modelId, transcriptText: 'into notes' }),
      deliveryPlatform,
      modelId: 'whisper-tiny.en',
    });

    expect(result.delivery.status).toBe('inserted');
    expect(result.delivery.message).toBe('Inserted');
    expect(result.copied).toBe(false);
    expect(insertText).toHaveBeenCalledWith('into notes', intended);
    expect(clip.copy).not.toHaveBeenCalled();
  });

  it('honors clipboardFallback=false on refused target', async () => {
    const clip = clipboard();
    const secure = {
      appName: 'Safari',
      appPid: 9,
      capturedAt: 1,
      elementId: '9:AXSecureTextField:',
      elementRole: 'AXSecureTextField',
      insertable: false,
      kind: 'secure' as const,
      reason: 'secure field — insert skipped',
    };
    const deliveryPlatform = {
      clipboardRead: vi.fn(),
      clipboardRestore: vi.fn(),
      clipboardWrite: vi.fn(),
      insertText: vi.fn(),
      snapshotTarget: vi.fn().mockResolvedValue(secure),
      validateTarget: vi.fn().mockResolvedValue(secure),
    };

    const result = await dogfoodTranscribeAndCopy({
      audio: { duration_ms: 100, id: 'pcm-sec', sample_rate_hz: 16_000 },
      clipboard: clip,
      clipboardFallback: false,
      createEngine: (modelId) =>
        createMockSttEngine({ modelId, transcriptText: 'password' }),
      deliveryPlatform,
      modelId: 'whisper-tiny.en',
    });

    expect(result.delivery.status).toBe('failed');
    expect(result.delivery.message).toMatch(/secure/i);
    expect(clip.copy).not.toHaveBeenCalled();
    expect(result.delivery.text).toBe('password');
  });
});

describe('dogfoodTranscribeAndCopy cleanup integration', () => {
  const cleanupSnapshot = {
    dictionary: ['Voxloom'],
    enabled: true,
    modelId: 'qwen3-0.6b-q4-k-m',
    style: 'formal' as const,
  };

  it.each(['disabled', 'missing', 'overflow', 'runtime'])(
    'does not announce cleaning on %s preflight', async (kind) => {
      const onCleanupStart = vi.fn();
      const engine = { cancel: vi.fn(), run: vi.fn().mockRejectedValue(
        new CleanupEngineError('runtime-error', 'worker unavailable'),
      ) };
      await dogfoodTranscribeAndCopy({
        audio: { duration_ms: 100, id: kind, sample_rate_hz: 16_000 },
        cleanup: {
          engine, requestId: kind, signal: processingSignal(),
          snapshot: { ...cleanupSnapshot,
            enabled: kind !== 'disabled', modelId: kind === 'missing' ? null : cleanupSnapshot.modelId },
        },
        clipboard: clipboard(), modelId: 'whisper-tiny.en', onCleanupStart,
        createEngine: (modelId) => createMockSttEngine({ modelId,
          transcriptText: kind === 'overflow' ? 'x'.repeat(16_001) : 'raw' }),
      });
      expect(onCleanupStart).not.toHaveBeenCalled();
    },
  );

  it.each(['', ' \n\t ', '\u2003'])(
    'rejects silence %j before cleanup or delivery', async (text) => {
      const clip = clipboard();
      const cleanupRun = vi.fn().mockResolvedValue('Invented speech.');
      const onCleanupStart = vi.fn();
      await expect(dogfoodTranscribeAndCopy({
        audio: { duration_ms: 100, id: 'silence', sample_rate_hz: 16_000 },
        cleanup: {
          engine: { cancel: vi.fn(), run: cleanupRun },
          requestId: 'silent',
          signal: processingSignal(),
          snapshot: cleanupSnapshot,
        },
        clipboard: clip,
        createEngine: (modelId) => createMockSttEngine({
          modelId, transcriptText: text,
        }),
        modelId: 'whisper-tiny.en',
        onCleanupStart,
      })).rejects.toMatchObject({ code: 'no-speech' });
      expect(cleanupRun).not.toHaveBeenCalled();
      expect(onCleanupStart).not.toHaveBeenCalled();
      expect(clip.copy).not.toHaveBeenCalled();
    },
  );

  it('preserves cancellation precedence over silence with cleanup disabled', async () => {
    await expect(dogfoodTranscribeAndCopy({
      audio: { duration_ms: 100, id: 'cancel-silence', sample_rate_hz: 16_000 },
      cleanup: {
        engine: { cancel: vi.fn(), run: vi.fn() },
        requestId: 'silent',
        signal: processingSignal(true),
        snapshot: { ...cleanupSnapshot, enabled: false },
      },
      clipboard: clipboard(),
      createEngine: (modelId) => createMockSttEngine({ modelId, transcriptText: '' }),
      modelId: 'whisper-tiny.en',
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('delivers exactly one cleaned transcript after STT', async () => {
    const clip = clipboard();
    const cleanupRun = vi.fn().mockResolvedValue('Cleaned transcript.');
    const result = await dogfoodTranscribeAndCopy({
      audio: { duration_ms: 100, id: 'cleaned', sample_rate_hz: 16_000 },
      cleanup: {
        engine: { cancel: vi.fn(), run: cleanupRun },
        requestId: 'cleanup-1',
        signal: processingSignal(),
        snapshot: cleanupSnapshot,
      },
      clipboard: clip,
      createEngine: (modelId) => createMockSttEngine({
        modelId,
        transcriptText: 'cleaned transcript',
      }),
      modelId: 'whisper-tiny.en',
    });

    expect(result.rawTranscript?.text).toBe('cleaned transcript');
    expect(result.transcript.text).toBe('Cleaned transcript.');
    expect(clip.copy).toHaveBeenCalledOnce();
    expect(clip.copy).toHaveBeenCalledWith('Cleaned transcript.');
  });

  it('settles cancellation and snapshots the target only after local cleanup', async () => {
    const events: string[] = [];
    const clip = clipboard();
    const snapshotTarget = vi.fn(async () => {
      events.push('snapshot');
      return null;
    });
    const result = await dogfoodTranscribeAndCopy({
      audio: { duration_ms: 100, id: 'cleanup-target-order', sample_rate_hz: 16_000 },
      beforeDelivery: async () => { events.push('finish-cancel-scope'); },
      cleanup: {
        engine: { cancel: vi.fn(), run: vi.fn(async () => {
          events.push('cleanup');
          expect(snapshotTarget).not.toHaveBeenCalled();
          return 'Cleaned transcript.';
        }) },
        requestId: 'cleanup-target-order', signal: processingSignal(), snapshot: cleanupSnapshot,
      },
      clipboard: clip,
      createEngine: () => ({ modelId: 'whisper-tiny.en', transcribe: async () => ({
        rawText: '[Music] cleaned transcript', text: 'cleaned transcript',
      }) }),
      modelId: 'whisper-tiny.en', snapshotTarget,
    });
    expect(events).toEqual(['cleanup', 'finish-cancel-scope', 'snapshot']);
    expect(result.rawTranscript?.rawText).toBe('[Music] cleaned transcript');
    expect(result.transcript.text).toBe('Cleaned transcript.');
    expect(clip.copy).toHaveBeenCalledExactlyOnceWith('Cleaned transcript.');
  });

  it('falls back once to raw text when cleanup output is invalid', async () => {
    const clip = clipboard();
    const result = await dogfoodTranscribeAndCopy({
      audio: { duration_ms: 100, id: 'fallback', sample_rate_hz: 16_000 },
      cleanup: {
        engine: {
          cancel: vi.fn(),
          run: vi.fn().mockResolvedValue('<think>reasoning</think>'),
        },
        requestId: 'cleanup-2',
        signal: processingSignal(),
        snapshot: cleanupSnapshot,
      },
      clipboard: clip,
      createEngine: (modelId) => createMockSttEngine({
        modelId,
        transcriptText: 'raw transcript',
      }),
      modelId: 'whisper-tiny.en',
    });

    expect(result.cleanup).toMatchObject({
      reason: 'invalid-output',
      status: 'fallback',
    });
    expect(clip.copy).toHaveBeenCalledWith('raw transcript');
  });

  it('does not write when cancellation is already requested', async () => {
    const clip = clipboard();
    await expect(dogfoodTranscribeAndCopy({
      audio: { duration_ms: 100, id: 'cancelled', sample_rate_hz: 16_000 },
      cleanup: {
        engine: { cancel: vi.fn(), run: vi.fn() },
        requestId: 'cleanup-3',
        signal: processingSignal(true),
        snapshot: cleanupSnapshot,
      },
      clipboard: clip,
      createEngine: (modelId) => createMockSttEngine({ modelId }),
      modelId: 'whisper-tiny.en',
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(clip.copy).not.toHaveBeenCalled();
  });

  it('does not write when cancellation arrives during STT', async () => {
    let aborted = false;
    const clip = clipboard();
    await expect(dogfoodTranscribeAndCopy({
      audio: { duration_ms: 100, id: 'cancel-stt', sample_rate_hz: 16_000 },
      cleanup: {
        engine: { cancel: vi.fn(), run: vi.fn() },
        requestId: 'cleanup-stt',
        signal: {
          get aborted() { return aborted; },
          onAbort: vi.fn(),
        },
        snapshot: cleanupSnapshot,
      },
      clipboard: clip,
      createEngine: () => ({
        modelId: 'whisper-tiny.en',
        async transcribe() {
          aborted = true;
          return { language: 'en', text: 'must not deliver' };
        },
      }),
      modelId: 'whisper-tiny.en',
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(clip.copy).not.toHaveBeenCalled();
  });

  it('reports an insert that had already begun when cancellation arrives', async () => {
    let aborted = false;
    const intended = {
      appName: 'Notes',
      appPid: 7,
      capturedAt: 1,
      elementId: '7:AXTextArea:',
      elementRole: 'AXTextArea',
      insertable: true,
      kind: 'insertable' as const,
      reason: null,
    };
    const result = await dogfoodTranscribeAndCopy({
      audio: { duration_ms: 100, id: 'write-begun', sample_rate_hz: 16_000 },
      cleanup: {
        engine: { cancel: vi.fn(), run: vi.fn() },
        requestId: 'cleanup-4',
        signal: {
          get aborted() { return aborted; },
          onAbort: vi.fn(),
        },
        snapshot: { ...cleanupSnapshot, enabled: false },
      },
      clipboard: clipboard(),
      createEngine: (modelId) => createMockSttEngine({ modelId }),
      deliveryPlatform: {
        clipboardRead: vi.fn(),
        clipboardRestore: vi.fn(),
        clipboardWrite: vi.fn(),
        insertText: vi.fn(async () => { aborted = true; }),
        snapshotTarget: vi.fn().mockResolvedValue(intended),
        validateTarget: vi.fn().mockResolvedValue(intended),
      },
      modelId: 'whisper-tiny.en',
    });

    expect(result.delivery.status).toBe('inserted');
    expect(result.delivery.message).toBe('Inserted');
  });
});
describe('completion-time delivery side effects', () => {
  it.each(['empty', 'error', 'cancelled'] as const)('avoids target and clipboard work for %s STT', async (mode) => {
    const clip = clipboard();
    const snapshotTarget = vi.fn();
    const validateTarget = vi.fn();
    const insertText = vi.fn();
    const clipboardWrite = vi.fn();
    const clipboardRead = vi.fn();
    const pending = dogfoodTranscribeAndCopy({
      audio: { duration_ms: 100, id: 'pcm-side-effects', sample_rate_hz: 16_000 },
      clipboard: clip,
      modelId: 'whisper-tiny.en',
      isCurrent: () => mode !== 'cancelled',
      createEngine: (modelId) => ({
        ...createMockSttEngine({ modelId }),
        transcribe: async () => {
          if (mode === 'error') throw new Error('STT failed');
          return { text: mode === 'empty' ? '  ' : 'cancelled text', language: 'en' };
        },
      }),
      deliveryPlatform: { snapshotTarget, validateTarget, insertText, clipboardWrite, clipboardRead, clipboardRestore: vi.fn() },
    });
    if (mode === 'error') await expect(pending).rejects.toThrow('STT failed');
    else expect((await pending).delivery.status).toBe('failed');
    for (const effect of [snapshotTarget, validateTarget, insertText, clipboardWrite, clipboardRead, clip.copy]) {
      expect(effect).not.toHaveBeenCalled();
    }
  });
});

describe('completion snapshot failures', () => {
  it.each([true, false])('honors fallback=%s when an asynchronous snapshot rejects', async (fallback) => {
    const clip = clipboard();
    const snapshotTarget = vi.fn().mockRejectedValue(new Error('AX worker rejected'));
    const result = await dogfoodTranscribeAndCopy({
      audio: { duration_ms: 100, id: 'pcm-snapshot-reject', sample_rate_hz: 16_000 },
      clipboard: clip,
      clipboardFallback: fallback,
      modelId: 'whisper-tiny.en',
      createEngine: (modelId) => createMockSttEngine({ modelId, transcriptText: 'recoverable transcript' }),
      snapshotTarget,
    });
    expect(snapshotTarget).toHaveBeenCalledOnce();
    expect(result.transcript.text).toBe('recoverable transcript');
    expect(result.delivery.status).toBe(fallback ? 'copied' : 'failed');
    expect(clip.copy).toHaveBeenCalledTimes(fallback ? 1 : 0);
    if (fallback) expect(clip.copy).toHaveBeenCalledWith('recoverable transcript');
  });

  it('cancellation during a rejecting snapshot prevents fallback and all later platform calls', async () => {
    let reject!: (error: Error) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const snapshot = new Promise<never>((_, fail) => { reject = fail; });
    let current = true;
    const clip = clipboard();
    const platform = {
      snapshotTarget: vi.fn(() => { entered(); return snapshot; }),
      validateTarget: vi.fn(), insertText: vi.fn(),
      clipboardWrite: vi.fn(), clipboardRead: vi.fn(), clipboardRestore: vi.fn(),
    };
    const pending = dogfoodTranscribeAndCopy({
      audio: { duration_ms: 100, id: 'pcm-cancelled-snapshot', sample_rate_hz: 16_000 },
      clipboard: clip, clipboardFallback: true,
      modelId: 'whisper-tiny.en',
      createEngine: (modelId) => createMockSttEngine({ modelId, transcriptText: 'old transcript' }),
      deliveryPlatform: platform, isCurrent: () => current,
    });
    await started;
    current = false;
    reject(new Error('late AX failure'));
    const result = await pending;
    expect(result.delivery.status).toBe('failed');
    expect(result.delivery.message).toContain('cancelled or superseded');
    expect(result.transcript.text).toBe('old transcript');
    expect(platform.snapshotTarget).toHaveBeenCalledOnce();
    for (const effect of [platform.validateTarget, platform.insertText, platform.clipboardWrite,
      platform.clipboardRead, platform.clipboardRestore, clip.copy]) {
      expect(effect).not.toHaveBeenCalled();
    }
  });

  it.each([true, false])('honors fallback=%s when snapshot throws synchronously', async (fallback) => {
    const clip = clipboard();
    const result = await dogfoodTranscribeAndCopy({
      audio: { duration_ms: 100, id: 'pcm-snapshot-fail', sample_rate_hz: 16_000 },
      clipboard: clip,
      clipboardFallback: fallback,
      modelId: 'whisper-tiny.en',
      createEngine: (modelId) => createMockSttEngine({ modelId }),
      snapshotTarget: () => { throw new Error('AX unavailable'); },
    });
    expect(result.delivery.status).toBe(fallback ? 'copied' : 'failed');
    expect(clip.copy).toHaveBeenCalledTimes(fallback ? 1 : 0);
  });

  describe('BUS-23 cleaned-to-empty transcripts', () => {
    for (const dropped of [
      'silent-audio',
      'no-speech',
      'non-speech-only',
      'quiet-hallucination',
    ] as const) {
      it(`${dropped}: nothing inserted or copied, status is not Inserted/Copied`, async () => {
        const clip = clipboard();
        const snapshotTarget = vi.fn();
        const insertText = vi.fn();
        const clipboardWrite = vi.fn();
        const result = await dogfoodTranscribeAndCopy({
          audio: { duration_ms: 900, id: 'pcm-quiet', sample_rate_hz: 16_000 },
          clipboard: clip,
          createEngine: (modelId) => ({
            modelId,
            transcribe: () => Promise.resolve({
              dropped,
              rawText: dropped === 'quiet-hallucination' ? 'Thank you.' : '',
              text: '',
            }),
          }),
          deliveryPlatform: {
            clipboardRead: vi.fn(),
            clipboardRestore: vi.fn(),
            clipboardWrite,
            insertText,
            snapshotTarget,
            validateTarget: vi.fn(),
          },
          modelId: 'whisper-tiny.en',
          snapshotTarget,
        });

        expect(clip.copy).not.toHaveBeenCalled();
        expect(insertText).not.toHaveBeenCalled();
        expect(clipboardWrite).not.toHaveBeenCalled();
        expect(snapshotTarget).not.toHaveBeenCalled();
        expect(result.copied).toBe(false);
        expect(result.delivery.status).toBe('failed');
        expect(result.delivery.message).toMatch(/nothing inserted or copied/);
        expect(result.delivery.message).not.toMatch(/Inserted|Copied/);
      });
    }

    it('keeps the generic wording for blank text without a drop reason', async () => {
      const clip = clipboard();
      const result = await dogfoodTranscribeAndCopy({
        audio: { duration_ms: 900, id: 'pcm-blank', sample_rate_hz: 16_000 },
        clipboard: clip,
        createEngine: (modelId) => ({
          modelId,
          transcribe: () => Promise.resolve({ text: '' }),
        }),
        modelId: 'whisper-tiny.en',
      });
      expect(clip.copy).not.toHaveBeenCalled();
      expect(result.delivery.message).toMatch(/empty transcript/);
    });

    it('delivers cleaned text (not raw) on the Copy path', async () => {
      const clip = clipboard();
      const result = await dogfoodTranscribeAndCopy({
        audio: { duration_ms: 900, id: 'pcm-clean', sample_rate_hz: 16_000 },
        clipboard: clip,
        createEngine: (modelId) => ({
          modelId,
          transcribe: () => Promise.resolve({
            rawText: '[Music] ship it',
            text: 'ship it',
          }),
        }),
        modelId: 'whisper-tiny.en',
      });
      expect(clip.copy).toHaveBeenCalledWith('ship it');
      expect(result.transcript.rawText).toBe('[Music] ship it');
    });
  });
});

// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockInvoke, mockIsTauri, mockListen } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockIsTauri: vi.fn(() => true),
  mockListen: vi.fn(async () => () => {}),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
  isTauri: () => mockIsTauri(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen,
}));

import {
  createWhisperSttEngine,
  createWhisperSttModelStore,
} from '../../../src/services/stt/whisperAdapter';
import { SttError } from '../../../src/services/stt/types';

describe('createWhisperSttEngine', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockIsTauri.mockReturnValue(true);
    mockListen.mockClear();
  });

  it('requires explicit non-empty modelId (no silent default download)', () => {
    expect(() => createWhisperSttEngine({ modelId: '' })).toThrow(SttError);
    expect(() => createWhisperSttEngine({ modelId: '   ' })).toThrow(
      SttError,
    );
  });

  it('does not invoke download or transcribe on construct', () => {
    const engine = createWhisperSttEngine({ modelId: 'whisper-tiny.en' });
    expect(engine.modelId).toBe('whisper-tiny.en');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('transcribe passes modelId and buffer id to native command', async () => {
    mockInvoke.mockResolvedValue({ language: 'en', text: 'hello' });
    const engine = createWhisperSttEngine({ modelId: 'whisper-base.en' });
    const result = await engine.transcribe({
      durationMs: 100,
      id: 'pcm-1',
      sampleRateHz: 16_000,
    });
    expect(result.text).toBe('hello');
    expect(mockInvoke).toHaveBeenCalledWith('stt_transcribe', {
      modelId: 'whisper-base.en',
      bufferId: 'pcm-1',
    });
  });

  it('transcribe awaits native async result (text from invoke, not early)', async () => {
    let resolveInvoke: (value: unknown) => void = () => {};
    mockInvoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInvoke = resolve;
        }),
    );
    const engine = createWhisperSttEngine({ modelId: 'whisper-tiny.en' });
    const pending = engine.transcribe({
      durationMs: 50,
      id: 'pcm-slow',
      sampleRateHz: 16_000,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveInvoke({ language: 'en', text: 'done after native finish' });
    await expect(pending).resolves.toMatchObject({
      text: 'done after native finish',
    });
    expect(settled).toBe(true);
  });

  it('maps native JSON errors to SttError', async () => {
    mockInvoke.mockRejectedValue(
      JSON.stringify({ code: 'model-missing', message: 'not downloaded' }),
    );
    const engine = createWhisperSttEngine({ modelId: 'whisper-tiny.en' });
    await expect(
      engine.transcribe({
        durationMs: 1,
        id: 'pcm-2',
        sampleRateHz: 16_000,
      }),
    ).rejects.toMatchObject({ code: 'model-missing' });
  });
});

describe('createWhisperSttModelStore', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockIsTauri.mockReturnValue(true);
    mockListen.mockReset();
    mockListen.mockImplementation(async () => () => {});
  });

  it('construct does not download', () => {
    createWhisperSttModelStore();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('download invokes explicit user-triggered command', async () => {
    mockInvoke.mockResolvedValue(undefined);
    const store = createWhisperSttModelStore();
    await store.download('whisper-tiny.en');
    expect(mockInvoke).toHaveBeenCalledWith('stt_download_model', {
      modelId: 'whisper-tiny.en',
    });
  });

  it('download subscribes to progress before invoke and does not complete on progress alone', async () => {
    const callOrder: string[] = [];
    let progressHandler:
      | ((event: { payload: { modelId: string; ratio: number } }) => void)
      | undefined;

    mockListen.mockImplementation(
      (async (
        _event: string,
        handler: (event: { payload: { modelId: string; ratio: number } }) => void,
      ) => {
        callOrder.push('listen');
        progressHandler = handler;
        return () => {
          callOrder.push('unlisten');
        };
      }) as typeof mockListen,
    );

    let resolveDownload: (value?: unknown) => void = () => {};
    mockInvoke.mockImplementation(((cmd: string) => {
      callOrder.push(`invoke:${cmd}`);
      if (cmd === 'stt_download_model') {
        return new Promise((resolve) => {
          resolveDownload = resolve;
        });
      }
      return Promise.resolve(undefined);
    }) as typeof mockInvoke);

    const store = createWhisperSttModelStore();
    const onProgress = vi.fn();
    const pending = store.download('whisper-tiny.en', onProgress);

    await vi.waitFor(() => {
      expect(callOrder).toEqual([
        'listen',
        'invoke:stt_download_model',
      ]);
    });

    // Simulate native progress including a premature-looking ratio.
    progressHandler?.({
      payload: { modelId: 'whisper-tiny.en', ratio: 0.999 },
    });
    progressHandler?.({
      payload: { modelId: 'whisper-tiny.en', ratio: 1 },
    });
    expect(onProgress).toHaveBeenCalled();
    // Promise must still be pending until invoke resolves.
    let done = false;
    void pending.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);

    resolveDownload(undefined);
    await pending;
    expect(done).toBe(true);
    expect(callOrder).toContain('unlisten');
  });

  it('cancel invokes stt_cancel_download (works while download is async)', async () => {
    mockInvoke.mockResolvedValue(undefined);
    const store = createWhisperSttModelStore();
    await store.cancel('whisper-tiny.en');
    expect(mockInvoke).toHaveBeenCalledWith('stt_cancel_download', {
      modelId: 'whisper-tiny.en',
    });
  });

  it('list uses stt_list_models', async () => {
    mockInvoke.mockResolvedValue([
      {
        id: 'whisper-tiny.en',
        label: 'Whisper Tiny (English)',
        sizeBytes: 1,
        status: 'missing',
      },
    ]);
    const store = createWhisperSttModelStore();
    const models = await store.list();
    expect(models[0]?.status).toBe('missing');
    expect(mockInvoke).toHaveBeenCalledWith('stt_list_models');
  });
});

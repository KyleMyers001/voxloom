/** @vitest-environment jsdom */
// BUS-138: dictionary words are written exactly as saved, on every delivery
// path, whether or not optional cleanup runs.
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CleanupOutcome } from '../../../src/services/cleanup/types';
import type { CaptureState } from '../../../src/services/capture/types';
import type { UseCaptureStateResult } from '../../../src/services/capture/useCaptureState';
import type { DeliveryPlatformAdapter, TargetSnapshot } from '../../../src/services/delivery';
import { dogfoodTranscribeAndCopy } from '../../../src/services/stt/dogfoodPath';
import { createMockSttEngine, createMockSttModelStore } from '../../../src/services/stt/mockStt';
import { useDogfoodCapture } from '../../../src/services/stt/useDogfoodCapture';

const WORDS = ['ChatGPT', 'Voxloom', 'Will'];
const HEARD = 'ask chat gpt about voxloom and will it work';
const FIXED = 'ask ChatGPT about Voxloom and will it work';

const NOTES: TargetSnapshot = {
  appName: 'Notes', appPid: 11, capturedAt: 1, elementId: '11:AXTextArea:#1',
  elementRole: 'AXTextArea', insertable: true, kind: 'insertable', pasteApp: null,
  pasteTerminal: false, reason: null,
};
const WEZTERM: TargetSnapshot = {
  appName: 'WezTerm', appPid: 77, capturedAt: 1, elementId: null, elementRole: null,
  insertable: false, kind: 'unsupported', knownTerminal: true,
  pasteApp: '/Applications/WezTerm.app', pasteTerminal: true, reason: 'no field',
};
const SECURE: TargetSnapshot = {
  appName: 'Safari', appPid: 9, capturedAt: 1, elementId: '9:AXSecureTextField:',
  elementRole: 'AXSecureTextField', insertable: false, kind: 'secure',
  reason: 'secure field — insert skipped',
};

function platform(target: TargetSnapshot): DeliveryPlatformAdapter {
  let board = 'prior';
  return {
    clipboardRead: vi.fn(async () => ({ ok: true, text: board })),
    clipboardRestore: vi.fn().mockResolvedValue(undefined),
    clipboardWrite: vi.fn(async (text: string) => { board = text; }),
    insertText: vi.fn().mockResolvedValue(undefined),
    pasteBinding: vi.fn().mockResolvedValue(
      target.pasteApp ? { appPid: target.appPid ?? 0, pasteApp: target.pasteApp } : null,
    ),
    pasteText: vi.fn().mockResolvedValue({ clipboardRestored: true, restoreSkippedReason: null }),
    snapshotTarget: vi.fn().mockResolvedValue(target),
    validateTarget: vi.fn().mockResolvedValue(target),
  };
}

function run(options: {
  cleanup?: (text: string) => Promise<CleanupOutcome>;
  dictionary?: readonly string[];
  heard?: string;
  rawText?: string;
  target: TargetSnapshot;
}) {
  const deliveryPlatform = platform(options.target);
  const result = dogfoodTranscribeAndCopy({
    audio: { duration_ms: 900, id: 'pcm-dict', sample_rate_hz: 16_000 },
    cleanup: options.cleanup,
    clipboard: { copy: vi.fn().mockResolvedValue(undefined) },
    createEngine: (modelId) => ({
      ...createMockSttEngine({ modelId }),
      transcribe: async () => ({
        language: 'en',
        ...(options.rawText ? { rawText: options.rawText } : {}),
        text: options.heard ?? HEARD,
      }),
    }),
    deliveryPlatform,
    dictionary: 'dictionary' in options ? options.dictionary : WORDS,
    modelId: 'whisper-tiny.en',
    pasteBinding: options.target.pasteApp
      ? { appPid: options.target.appPid ?? 0, pasteApp: options.target.pasteApp }
      : null,
  });
  return { deliveryPlatform, result };
}

describe('every delivery path gets the replaced text', () => {
  it('Insert', async () => {
    const { deliveryPlatform, result } = run({ target: NOTES });
    const done = await result;
    expect(done.delivery.status).toBe('inserted');
    expect(deliveryPlatform.insertText).toHaveBeenCalledWith(FIXED, NOTES);
    expect(done.transcript.text).toBe(FIXED);
  });

  it('Copy', async () => {
    const { deliveryPlatform, result } = run({ target: SECURE });
    const done = await result;
    expect(done.delivery.status).toBe('copied');
    expect(deliveryPlatform.clipboardWrite).toHaveBeenCalledWith(FIXED);
  });

  it('terminal paste', async () => {
    const { deliveryPlatform, result } = run({ target: WEZTERM });
    const done = await result;
    expect(done.delivery.status).toBe('unverified');
    expect(deliveryPlatform.pasteText).toHaveBeenCalledWith(FIXED, {
      appPid: 77, pasteApp: '/Applications/WezTerm.app',
    });
  });

  it('shows the replaced text in the returned delivery outcome', async () => {
    const { result } = run({ target: SECURE });
    expect((await result).delivery.text).toBe(FIXED);
  });
});

describe('with optional cleanup', () => {
  it('hands cleanup the replaced text', async () => {
    const cleanup = vi.fn(async (text: string): Promise<CleanupOutcome> => ({
      finalText: text, status: 'skipped',
    }));
    await run({ cleanup, target: SECURE }).result;
    expect(cleanup).toHaveBeenCalledWith(FIXED);
  });

  it('keeps the fixes when cleanup falls back to the transcript', async () => {
    const cleanup = async (text: string): Promise<CleanupOutcome> => ({
      finalText: text, reason: 'invalid-output', status: 'fallback',
    });
    const { deliveryPlatform, result } = run({ cleanup, target: SECURE });
    const done = await result;
    expect(deliveryPlatform.clipboardWrite).toHaveBeenCalledWith(FIXED);
    expect(done.transcript.text).toBe(FIXED);
  });

  it('fixes cleaned text again when cleanup undoes a spelling', async () => {
    const cleanup = async (): Promise<CleanupOutcome> => ({
      finalText: 'Ask chat gpt about voxloom.', status: 'cleaned',
    });
    const { deliveryPlatform, result } = run({ cleanup, target: SECURE });
    const done = await result;
    expect(deliveryPlatform.clipboardWrite).toHaveBeenCalledWith('Ask ChatGPT about Voxloom.');
    expect(done.transcript.text).toBe('Ask ChatGPT about Voxloom.');
  });

  it('is idempotent when cleanup already used the spellings', async () => {
    const cleanup = async (): Promise<CleanupOutcome> => ({
      finalText: 'Ask ChatGPT about Voxloom.', status: 'cleaned',
    });
    const { deliveryPlatform, result } = run({ cleanup, target: SECURE });
    await result;
    expect(deliveryPlatform.clipboardWrite).toHaveBeenCalledWith('Ask ChatGPT about Voxloom.');
  });
});

describe('History text', () => {
  it('keeps the engine output as rawText', async () => {
    const done = await run({ target: SECURE }).result;
    expect(done.transcript).toMatchObject({ rawText: HEARD, text: FIXED });
  });

  it('keeps the engine rawText when it already has one', async () => {
    const done = await run({ rawText: 'raw engine words', target: SECURE }).result;
    expect(done.transcript).toMatchObject({ rawText: 'raw engine words', text: FIXED });
  });

  it('after cleanup, rawText is still the engine output', async () => {
    const cleanup = async (): Promise<CleanupOutcome> => ({
      finalText: 'Ask chat gpt.', status: 'cleaned',
    });
    const done = await run({ cleanup, target: SECURE }).result;
    expect(done.transcript).toMatchObject({ rawText: HEARD, text: 'Ask ChatGPT.' });
  });

  it('leaves the transcript untouched when nothing matches', async () => {
    const done = await run({ heard: 'plain words', target: SECURE }).result;
    expect(done.transcript).toEqual({ language: 'en', text: 'plain words' });
  });
});

describe('no dictionary', () => {
  it.each([[[]], [undefined]])('delivers the engine text unchanged (%j)', async (dictionary) => {
    const done = await run({ dictionary: dictionary as string[], target: SECURE }).result;
    expect(done.transcript).toEqual({ language: 'en', text: HEARD });
  });
});

describe('from the hook', () => {
  it('uses the dictionary the user has when dictation stops', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    const deliveryPlatform = platform(WEZTERM);
    const records: Array<{ rawText?: string; text: string }> = [];
    const capture = (state: CaptureState): UseCaptureStateResult => ({
      cancelActiveCapture: vi.fn(), captureReady: true, captureState: state,
      deviceListError: null, devices: [], devicesLoading: false,
      permissionStatus: 'authorized', prepareDeviceChange: vi.fn().mockResolvedValue(true),
      refreshDevices: vi.fn().mockResolvedValue(undefined), requestMicPermission: vi.fn(),
      runMicTest: vi.fn(), startFullCaptureSession: vi.fn().mockResolvedValue('started'),
      stopFullCapture: vi.fn(), stopMicTest: vi.fn(),
    });
    const dogfood: typeof dogfoodTranscribeAndCopy = (options) => dogfoodTranscribeAndCopy({
      ...options,
      createEngine: (modelId) => ({
        ...createMockSttEngine({ modelId }),
        transcribe: async () => ({ language: 'en', text: HEARD }),
      }),
    });
    const { rerender, result } = renderHook(
      ({ dictionary, state }: { dictionary: string[]; state: CaptureState }) => useDogfoodCapture({
        captureApi: capture(state),
        clipboard: { copy: vi.fn().mockResolvedValue(undefined) },
        createModelStore: () => store,
        deliveryPlatform,
        dictionary,
        dogfood,
        modelId: 'whisper-tiny.en',
        onHistoryRecord: (record) => records.push(record),
      }),
      { initialProps: { dictionary: [] as string[], state: { kind: 'idle' } as CaptureState } },
    );
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    rerender({
      dictionary: WORDS,
      state: { audio: { duration_ms: 700, id: 'a1', sample_rate_hz: 16_000 }, kind: 'stopped' },
    });
    await waitFor(() => expect(records).toHaveLength(1));
    expect(deliveryPlatform.pasteText).toHaveBeenCalledWith(FIXED, expect.anything());
    expect(records[0]).toMatchObject({ rawText: HEARD, text: FIXED });
  });
});

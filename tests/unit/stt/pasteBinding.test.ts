/** @vitest-environment jsdom */
// The terminal a paste may go to is the one in front when dictation starts:
// captured at start(), read at delivery, never re-derived after transcription.
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CaptureState } from '../../../src/services/capture/types';
import type { UseCaptureStateResult } from '../../../src/services/capture/useCaptureState';
import type { DeliveryPlatformAdapter, TargetSnapshot } from '../../../src/services/delivery';
import { dogfoodTranscribeAndCopy } from '../../../src/services/stt/dogfoodPath';
import { createMockSttEngine, createMockSttModelStore } from '../../../src/services/stt/mockStt';
import { useDogfoodCapture } from '../../../src/services/stt/useDogfoodCapture';

type App = 'notes' | 'wezterm' | 'ghostty';

const APPS: Record<App, TargetSnapshot> = {
  ghostty: {
    appName: 'Ghostty', appPid: 88, capturedAt: 1, elementId: null, elementRole: null,
    insertable: false, kind: 'unsupported', knownTerminal: true,
    pasteApp: '/Applications/Ghostty.app', pasteTerminal: true, reason: 'no field',
  },
  notes: {
    appName: 'Notes', appPid: 11, capturedAt: 1, elementId: '11:AXTextArea:#1',
    elementRole: 'AXTextArea', insertable: true, kind: 'insertable', pasteApp: null,
    pasteTerminal: false, reason: null,
  },
  wezterm: {
    appName: 'WezTerm', appPid: 77, capturedAt: 1, elementId: null, elementRole: null,
    insertable: false, kind: 'unsupported', knownTerminal: true,
    pasteApp: '/Applications/WezTerm.app', pasteTerminal: true, reason: 'no field',
  },
};

function stubCapture(state: CaptureState): UseCaptureStateResult {
  return {
    cancelActiveCapture: vi.fn(), captureReady: true, captureState: state,
    deviceListError: null, devices: [], devicesLoading: false,
    permissionStatus: 'authorized', prepareDeviceChange: vi.fn().mockResolvedValue(true),
    refreshDevices: vi.fn().mockResolvedValue(undefined), requestMicPermission: vi.fn(),
    runMicTest: vi.fn(), startFullCaptureSession: vi.fn().mockResolvedValue('started'),
    stopFullCapture: vi.fn(), stopMicTest: vi.fn(),
  };
}

/** Dictate with `atStart` in front, switch to `atDelivery` during transcription. */
async function dictate(atStart: App, atDelivery: App) {
  const store = createMockSttModelStore();
  await store.download('whisper-tiny.en');
  let front: App = atStart;
  let board = 'prior';
  const pasteBinding = vi.fn(async () => {
    const app = APPS[front];
    return app.pasteTerminal && app.appPid != null && app.pasteApp
      ? { appPid: app.appPid, pasteApp: app.pasteApp }
      : null;
  });
  const platform: DeliveryPlatformAdapter = {
    clipboardRead: vi.fn(async () => ({ ok: true, text: board })),
    clipboardRestore: vi.fn().mockResolvedValue(undefined),
    clipboardWrite: vi.fn(async (text: string) => { board = text; }),
    insertText: vi.fn().mockResolvedValue(undefined),
    pasteBinding,
    pasteText: vi.fn().mockResolvedValue({ clipboardRestored: true, restoreSkippedReason: null }),
    snapshotTarget: vi.fn(async () => APPS[front]),
    validateTarget: vi.fn(async () => APPS[front]),
  };
  let resolveStt!: (value: { text: string; language: string }) => void;
  const transcribe = vi.fn(() => new Promise<{ text: string; language: string }>((resolve) => {
    resolveStt = resolve;
  }));
  const dogfood: typeof dogfoodTranscribeAndCopy = (options) => dogfoodTranscribeAndCopy({
    ...options,
    createEngine: (modelId) => ({ ...createMockSttEngine({ modelId }), transcribe }),
  });
  const toasts: string[] = [];
  const records: Array<{ status: string }> = [];
  const { result, rerender } = renderHook(({ state }: { state: CaptureState }) => useDogfoodCapture({
    captureApi: stubCapture(state),
    clipboard: { copy: vi.fn().mockResolvedValue(undefined) },
    createModelStore: () => store,
    deliveryPlatform: platform,
    dogfood,
    modelId: 'whisper-tiny.en',
    onHistoryRecord: (record) => records.push(record),
    onToast: (message) => toasts.push(message),
  }), { initialProps: { state: { kind: 'idle' } as CaptureState } });
  await act(async () => { await result.current.start(); });
  await act(async () => { await result.current.stop(); });
  rerender({ state: { kind: 'stopped', audio: { id: 'a1', duration_ms: 700, sample_rate_hz: 16_000 } } });
  await waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
  front = atDelivery;
  await act(async () => { resolveStt({ language: 'en', text: 'hello there' }); });
  await waitFor(() => expect(result.current.phase).toBe('success'));
  await waitFor(() => expect(records).toHaveLength(1));
  return { pasteBinding, platform, records, result, toasts };
}

describe('paste binding captured at hold start', () => {
  it('Notes at hold start, WezTerm at delivery: copies, never pastes', async () => {
    const { platform, records } = await dictate('notes', 'wezterm');
    expect(platform.pasteText).not.toHaveBeenCalled();
    expect(records[0].status).toBe('copied');
    expect(platform.clipboardWrite).toHaveBeenCalledWith('hello there');
  });

  it('WezTerm at hold start, Ghostty during transcription: copies, never pastes', async () => {
    const { platform, records } = await dictate('wezterm', 'ghostty');
    expect(platform.pasteText).not.toHaveBeenCalled();
    expect(records[0].status).toBe('copied');
  });

  it('WezTerm throughout: pastes into the terminal captured at hold start, silently', async () => {
    const { pasteBinding, platform, records, result, toasts } = await dictate('wezterm', 'wezterm');
    expect(platform.pasteText).toHaveBeenCalledWith('hello there', { appPid: 77, pasteApp: '/Applications/WezTerm.app' });
    // Looked up once, when the session started: not again at delivery.
    expect(pasteBinding).toHaveBeenCalledTimes(1);
    expect(records[0].status).toBe('unverified');
    // No status line, no toast beyond the progress ones; the HUD stays quiet.
    expect(result.current.message).toBeNull();
    expect(result.current.hudResult).toBeNull();
    expect(toasts.filter((t) => /paste|clipboard|inserted|copied/i.test(t))).toEqual([]);
  });

  it('an adapter with no paste support captures nothing and behaves as before', async () => {
    const store = createMockSttModelStore();
    await store.download('whisper-tiny.en');
    let board = 'prior';
    const platform: DeliveryPlatformAdapter = {
      clipboardRead: vi.fn(async () => ({ ok: true, text: board })),
      clipboardRestore: vi.fn().mockResolvedValue(undefined),
      clipboardWrite: vi.fn(async (text: string) => { board = text; }),
      insertText: vi.fn().mockResolvedValue(undefined),
      snapshotTarget: vi.fn(async () => APPS.wezterm),
      validateTarget: vi.fn(async () => APPS.wezterm),
    };
    const records: Array<{ status: string }> = [];
    const { result, rerender } = renderHook(({ state }: { state: CaptureState }) => useDogfoodCapture({
      captureApi: stubCapture(state), clipboard: { copy: vi.fn().mockResolvedValue(undefined) },
      createModelStore: () => store, deliveryPlatform: platform, modelId: 'whisper-tiny.en',
      onHistoryRecord: (record) => records.push(record),
    }), { initialProps: { state: { kind: 'idle' } as CaptureState } });
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    rerender({ state: { kind: 'stopped', audio: { id: 'a2', duration_ms: 700, sample_rate_hz: 16_000 } } });
    await waitFor(() => expect(records).toHaveLength(1));
    expect(records[0].status).toBe('copied');
  });
});

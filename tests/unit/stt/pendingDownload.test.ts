/// BUS-76: a Models remount before the backend registers a download.
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createMockSttModelStore } from '../../../src/services/stt/mockStt';
import { SttError, type SttModelInfo } from '../../../src/services/stt/types';
import { DOWNLOAD_POLL_MS } from '../../../src/services/stt/useDownloadPoll';
import { useSttModels } from '../../../src/services/stt/useSttModels';

const row = (id: string, status: SttModelInfo['status']): SttModelInfo => ({ id, label: id, sizeBytes: 1, status });
const base = (models: readonly SttModelInfo[]) => models.find((m) => m.id === 'whisper-base.en')?.status;
const opts = (store: ReturnType<typeof createMockSttModelStore>) => ({ onSelect: vi.fn(), selectedModelId: 'whisper-tiny.en', store });

describe('pending download across remount (BUS-76)', () => {
  it('a remount before the backend reports downloading still shows it and refreshes after', async () => {
    let status: SttModelInfo['status'] = 'missing';
    let finish: () => void = () => {};
    const store = Object.assign(createMockSttModelStore(), {
      download: vi.fn(() => new Promise<void>((resolve) => { finish = () => { status = 'available'; resolve(); }; })),
      list: vi.fn(async () => [row('whisper-tiny.en', 'missing'), row('whisper-base.en', status)]),
    });
    const first = renderHook(() => useSttModels(opts(store)));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = first.result.current.downloadModel('whisper-base.en'); });
    first.unmount();

    const second = renderHook(() => useSttModels(opts(store)));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(base(second.result.current.models)).toBe('downloading');
    await act(async () => { finish(); await pending; });
    await waitFor(() => expect(base(second.result.current.models)).toBe('available'), { timeout: DOWNLOAD_POLL_MS * 3 });
    second.unmount();
  });

  it('shows a plain message when the native side refuses a second download', async () => {
    const store = Object.assign(createMockSttModelStore(), {
      download: vi.fn(async () => { throw new SttError('download-failed', 'Another model download is already in progress'); }),
    });
    const { result } = renderHook(() => useSttModels(opts(store)));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.downloadModel('whisper-base.en').catch(() => {}); });
    expect(result.current.failures['whisper-base.en']).toBe('Another model is downloading. Try again when it finishes.');
  });
});

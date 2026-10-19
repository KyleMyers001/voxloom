/// BUS-35: the startup check's stt:models-changed event re-lists Settings → Models.
/// BUS-85.2: also refresh once after the listener registers so an early event isn't missed.
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockSttModelStore } from '../../src/services/stt/mockStt';
import { useSttModels } from '../../src/services/stt/useSttModels';

const changed = vi.hoisted(() => {
  let resolveListen: ((un: () => void) => void) | null = null;
  return {
    defer: false,
    handler: null as (() => void) | null,
    unlisten: vi.fn(),
    async listen(h: () => void) {
      changed.handler = h;
      if (!changed.defer) return changed.unlisten;
      return new Promise<() => void>((resolve) => {
        resolveListen = resolve;
      });
    },
    resolveRegistration() {
      resolveListen?.(changed.unlisten);
      resolveListen = null;
    },
    reset() {
      changed.defer = false;
      changed.handler = null;
      changed.unlisten.mockClear();
      resolveListen = null;
    },
  };
});

vi.mock('../../src/services/stt/modelsChanged', () => ({
  listenModelsChanged: (h: () => void) => changed.listen(h),
}));

describe('stt:models-changed', () => {
  afterEach(() => {
    changed.reset();
  });

  it('re-lists models when the backend finishes checking a file', async () => {
    const store = createMockSttModelStore();
    const models = await store.list();
    const list = vi.spyOn(store, 'list');
    const { result, unmount } = renderHook(() => useSttModels({ onSelect: vi.fn(), selectedModelId: 'whisper-tiny.en', store }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(changed.handler).not.toBeNull());
    list.mockResolvedValue(models.map((m) => (m.id === 'whisper-base.en' ? { ...m, status: 'failed' as const } : m)));
    await act(async () => { changed.handler!(); });
    await waitFor(() => expect(result.current.models.find((m) => m.id === 'whisper-base.en')?.status).toBe('failed'));
    unmount();
    expect(changed.unlisten).toHaveBeenCalled();
  });

  it('refreshes once after the listener registers so an early event is not missed (BUS-85.2)', async () => {
    changed.defer = true;
    const store = createMockSttModelStore();
    const models = await store.list();
    const list = vi.spyOn(store, 'list');
    const { result, unmount } = renderHook(() => useSttModels({ onSelect: vi.fn(), selectedModelId: 'whisper-tiny.en', store }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.models.find((m) => m.id === 'whisper-base.en')?.status).toBe('missing');
    // Startup check finished before listen resolved — models on disk are now failed.
    list.mockResolvedValue(models.map((m) => (m.id === 'whisper-base.en' ? { ...m, status: 'failed' as const } : m)));
    const callsBefore = list.mock.calls.length;
    await act(async () => { changed.resolveRegistration(); });
    await waitFor(() => expect(result.current.models.find((m) => m.id === 'whisper-base.en')?.status).toBe('failed'));
    expect(list.mock.calls.length).toBeGreaterThan(callsBefore);
    unmount();
    expect(changed.unlisten).toHaveBeenCalled();
  });
});

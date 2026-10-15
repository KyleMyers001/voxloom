/// BUS-77: a damaged file found by the startup hash re-lists Settings → Models.
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockSttModelStore } from '../../src/services/stt/mockStt';
import { useSttModels } from '../../src/services/stt/useSttModels';

const changed = vi.hoisted(() => ({ handler: null as (() => void) | null, unlisten: vi.fn() }));
vi.mock('../../src/services/stt/modelsChanged', () => ({
  listenModelsChanged: async (h: () => void) => { changed.handler = h; return changed.unlisten; },
}));

describe('stt:models-changed (BUS-77)', () => {
  it('re-lists models when the backend reports a damaged file', async () => {
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
});

import { invoke, isTauri } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTauriOverlayApi } from '../../src/services/shortcut/overlayWindowApi';

describe('Plasma window envelope contract', () => {
  beforeEach(() => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(invoke).mockClear();
  });

  it('adds 24px on each side while preserving the original visible pill center', async () => {
    const api = createTauriOverlayApi();
    await api.ensureCreated();
    expect(invoke).toHaveBeenLastCalledWith('overlay_ensure', {
      height: 76, label: 'dictation-overlay', marginBottom: 4, width: 190,
    });
    await api.showBottomCenter();
    expect(invoke).toHaveBeenLastCalledWith('overlay_show', {
      cancellable: true, height: 76, label: 'dictation-overlay', marginBottom: 4, width: 190,
    });
    const args = vi.mocked(invoke).mock.calls.at(-1)![1] as { height: number; marginBottom: number };
    expect(args.marginBottom + args.height / 2).toBe(28 + 28 / 2);
  });

  it('keeps the result size, original result margin and cancellation contract', async () => {
    const api = createTauriOverlayApi();
    await api.showBottomCenter({ height: 40, width: 248 }, false);
    expect(invoke).toHaveBeenLastCalledWith('overlay_show', {
      cancellable: false, height: 40, label: 'dictation-overlay', marginBottom: 28, width: 248,
    });
  });
});

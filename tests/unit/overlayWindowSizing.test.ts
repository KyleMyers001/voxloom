import { invoke } from '@tauri-apps/api/core';
import { describe, expect, it, vi } from 'vitest';
import { createTauriOverlayApi } from '../../src/services/shortcut/overlayWindowApi';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  isTauri: () => true,
}));

describe('Resonance native-window geometry requests', () => {
  it('adds 24px on all sides and offsets only the listening/processing margin to preserve the visible center', async () => {
    const api = createTauriOverlayApi();
    await api.ensureCreated();
    expect(invoke).toHaveBeenLastCalledWith('overlay_ensure', {
      height: 76, label: 'dictation-overlay', marginBottom: 4, width: 190,
    });
    await api.showBottomCenter();
    expect(invoke).toHaveBeenLastCalledWith('overlay_show', {
      cancellable: true, height: 76, label: 'dictation-overlay', marginBottom: 4, width: 190,
    });
    // Bottom-to-center distance stays 42px: formerly 28 + 28/2.
    expect(4 + 76 / 2).toBe(28 + 28 / 2);
    await api.showBottomCenter({ height: 40, width: 248 }, false);
    expect(invoke).toHaveBeenLastCalledWith('overlay_show', {
      cancellable: false, height: 40, label: 'dictation-overlay', marginBottom: 28, width: 248,
    });
  });
});

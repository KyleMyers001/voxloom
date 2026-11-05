import { invoke, isTauri } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OVERLAY_LISTEN_PLACEMENT, OVERLAY_WINDOW_LABEL } from '../../src/services/shortcut/constants';
import { createTauriOverlayApi } from '../../src/services/shortcut/overlayWindowApi';

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  vi.mocked(isTauri).mockReturnValue(true);
});

describe('overlay window placement', () => {
  it('clears the Aurora halo on every side without moving the 136×22 pill', () => {
    const { height, marginBottom, width } = OVERLAY_LISTEN_PLACEMENT;
    expect((width - 136) / 2).toBeGreaterThanOrEqual(24);
    expect((height - 22) / 2).toBeGreaterThanOrEqual(24);
    // Same pill center as the original 142×28 window resting 28pt above the work area.
    expect(marginBottom + height / 2).toBe(28 + 28 / 2);
  });

  it('creates the window at the listening placement', async () => {
    await createTauriOverlayApi().ensureCreated();
    expect(invoke).toHaveBeenLastCalledWith('overlay_ensure', { label: OVERLAY_WINDOW_LABEL, ...OVERLAY_LISTEN_PLACEMENT });
  });

  it('shows at exactly the size and margin the caller gives', async () => {
    const placement = { height: 50, marginBottom: 9, width: 300 };
    const api = createTauriOverlayApi();
    await api.showBottomCenter(placement);
    expect(invoke).toHaveBeenLastCalledWith('overlay_show', { cancellable: true, label: OVERLAY_WINDOW_LABEL, ...placement });
    await api.showBottomCenter(placement, false);
    expect(invoke).toHaveBeenLastCalledWith('overlay_show', { cancellable: false, label: OVERLAY_WINDOW_LABEL, ...placement });
  });
});

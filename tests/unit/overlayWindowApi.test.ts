import { invoke, isTauri } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OVERLAY_BOTTOM_MARGIN,
  OVERLAY_HEIGHT,
  OVERLAY_RESULT_HEIGHT,
  OVERLAY_RESULT_WIDTH,
  OVERLAY_WIDTH,
  OVERLAY_WINDOW_LABEL,
} from '../../src/services/shortcut/constants';
import { createTauriOverlayApi } from '../../src/services/shortcut/overlayWindowApi';

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  vi.mocked(isTauri).mockReturnValue(true);
});

describe('Aurora window envelope', () => {
  it('reserves 24px per side while retaining the original visible pill center', async () => {
    expect({ height: OVERLAY_HEIGHT, width: OVERLAY_WIDTH }).toEqual({ height: 76, width: 190 });
    expect(OVERLAY_BOTTOM_MARGIN).toBe(4);
    expect(OVERLAY_BOTTOM_MARGIN + OVERLAY_HEIGHT / 2).toBe(28 + 28 / 2);
    const api = createTauriOverlayApi();
    await api.ensureCreated();
    expect(invoke).toHaveBeenLastCalledWith('overlay_ensure', {
      height: OVERLAY_HEIGHT, label: OVERLAY_WINDOW_LABEL,
      marginBottom: OVERLAY_BOTTOM_MARGIN, width: OVERLAY_WIDTH,
    });
    await api.showBottomCenter();
    expect(invoke).toHaveBeenLastCalledWith('overlay_show', {
      cancellable: true, height: OVERLAY_HEIGHT, label: OVERLAY_WINDOW_LABEL,
      marginBottom: OVERLAY_BOTTOM_MARGIN, width: OVERLAY_WIDTH,
    });
    // Processing and non-cancellable listening still share the listening envelope.
    await api.showBottomCenter({ height: OVERLAY_HEIGHT, width: OVERLAY_WIDTH }, false);
    expect(invoke).toHaveBeenLastCalledWith('overlay_show', {
      cancellable: false, height: OVERLAY_HEIGHT, label: OVERLAY_WINDOW_LABEL,
      marginBottom: OVERLAY_BOTTOM_MARGIN, width: OVERLAY_WIDTH,
    });
  });

  it('keeps result size and its original 28px bottom margin', async () => {
    expect({ height: OVERLAY_RESULT_HEIGHT, width: OVERLAY_RESULT_WIDTH }).toEqual({ height: 40, width: 248 });
    await createTauriOverlayApi().showBottomCenter({ height: OVERLAY_RESULT_HEIGHT, width: OVERLAY_RESULT_WIDTH }, false);
    expect(invoke).toHaveBeenLastCalledWith('overlay_show', {
      cancellable: false, height: 40, label: OVERLAY_WINDOW_LABEL,
      marginBottom: 28, width: 248,
    });
  });
});

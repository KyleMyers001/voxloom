import { describe, expect, it, vi } from 'vitest';
import {
  isOverlayVisible,
  overlayWaveformFromDictation,
} from '../../src/services/shortcut/overlayVisibility';
import { createOverlayBridge, overlaySyncPlan } from
  '../../src/services/shortcut/overlayBridge';

describe('overlay visibility', () => {
  it('is visible only for listening and processing', () => {
    expect(isOverlayVisible('ready')).toBe(false);
    expect(isOverlayVisible('listening')).toBe(true);
    expect(isOverlayVisible('processing')).toBe(true);
    expect(isOverlayVisible('success')).toBe(false);
    expect(isOverlayVisible('cancelled')).toBe(false);
    expect(isOverlayVisible('error')).toBe(false);
  });

  it('maps dictation waveform for the overlay bridge', () => {
    expect(overlayWaveformFromDictation({
      kind: 'listening',
      runId: 1,
      waveform: 'silent',
    })).toBe('silent');
    expect(overlayWaveformFromDictation({
      kind: 'listening',
      runId: 1,
      waveform: 'speaking',
    })).toBe('speaking');
    expect(overlayWaveformFromDictation({
      completion: 'held',
      kind: 'processing',
      runId: 1,
    })).toBe('processing');
    expect(overlayWaveformFromDictation({ kind: 'ready' })).toBeNull();
  });

  it('uses the same floating overlay for Home capture', () => {
    expect(overlaySyncPlan({ kind: 'ready' }, true))
      .toEqual({ visible: true, waveform: 'silent' });
    expect(overlaySyncPlan({ kind: 'ready' }, false))
      .toEqual({ visible: false, waveform: null });
  });

  it('shows Home capture in the overlay and hides it on stop', async () => {
    const api = {
      ensureCreated: vi.fn().mockResolvedValue(undefined),
      hide: vi.fn().mockResolvedValue(undefined),
      isAvailable: () => true,
      setWaveform: vi.fn().mockResolvedValue(undefined),
      showBottomCenter: vi.fn().mockResolvedValue(undefined),
    };
    const bridge = createOverlayBridge(api);
    await bridge.sync({ kind: 'ready' }, true);
    expect(api.setWaveform).toHaveBeenCalledWith('silent');
    expect(api.showBottomCenter).toHaveBeenCalledOnce();
    await bridge.sync({ kind: 'ready' });
    expect(api.hide).toHaveBeenCalledOnce();
  });

  it('overlaySyncPlan hides after cancel/error', () => {
    expect(overlaySyncPlan({
      kind: 'listening',
      runId: 2,
      waveform: 'speaking',
    })).toEqual({ visible: true, waveform: 'speaking' });
    expect(overlaySyncPlan({ kind: 'cancelled', runId: 2 }))
      .toEqual({ visible: false, waveform: null });
    expect(overlaySyncPlan({
      kind: 'error',
      recordId: 'x',
      runId: 2,
    })).toEqual({ visible: false, waveform: null });
  });
});

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OverlayWaveformView } from '../../src/overlay/OverlayWaveformView';
import type { OverlayWaveform } from '../../src/services/shortcut/overlayVisibility';

describe('Resonance listening decoration', () => {
  it('reacts to the newest display level, quiets in silence and clamps malformed input', () => {
    const { container, rerender } = render(<OverlayWaveformView levels={[1, 0]} waveform="speaking" />);
    const opacity = () => Number(container.querySelector<HTMLElement>('.hud-resonance')!.style.getPropertyValue('--resonance-opacity'));
    expect(opacity()).toBe(0);
    rerender(<OverlayWaveformView levels={[0, 0.5]} waveform="speaking" />);
    const medium = opacity();
    expect(medium).toBeGreaterThan(0);
    rerender(<OverlayWaveformView levels={[1]} waveform="speaking" />);
    const loud = opacity();
    expect(loud).toBeGreaterThan(medium);
    expect(loud).toBeLessThanOrEqual(1);
    rerender(<OverlayWaveformView levels={[5]} waveform="speaking" />);
    expect(opacity()).toBe(loud);
    for (const levels of [[], [NaN], [Infinity], [-Infinity], [-2]]) {
      rerender(<OverlayWaveformView levels={levels} waveform="speaking" />);
      expect(opacity()).toBe(0);
    }
    rerender(<OverlayWaveformView levels={[1]} waveform="silent" />);
    expect(opacity()).toBe(0);
  });
  it('keeps decorative capsule ripples only in listening states without replacing the bars or live region', () => {
    const { container, rerender } = render(<OverlayWaveformView levels={[0.5]} waveform="speaking" />);
    const live = container.querySelector('[role="status"]');
    for (const waveform of ['silent', 'speaking'] as const) {
      rerender(<OverlayWaveformView levels={[0.5]} waveform={waveform} />);
      expect(container.querySelector('.hud-resonance')).toHaveAttribute('aria-hidden', 'true');
      expect(container.querySelectorAll('.hud-resonance__ripple')).toHaveLength(3);
      expect(container.querySelectorAll('.wave i')).toHaveLength(24);
      expect(container.querySelector('[role="status"]')).toBe(live);
    }
    for (const waveform of ['processing', 'result-copied', 'result-unverified', 'result-failed'] as OverlayWaveform[]) {
      rerender(<OverlayWaveformView levels={[1]} waveform={waveform} />);
      expect(container.querySelector('.hud-resonance')).toBeNull();
      expect(container.querySelector('[role="status"]')).toBe(live);
    }
  });
});

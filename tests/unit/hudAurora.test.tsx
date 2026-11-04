import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OverlayWaveformView } from '../../src/overlay/OverlayWaveformView';

describe('Aurora listening decoration', () => {
  it('uses bounded display history for modest reactive energy, including malformed levels', () => {
    const { container, rerender } = render(<OverlayWaveformView levels={[]} waveform="silent" />);
    const energy = () => container.querySelector<HTMLElement>('.hud-aurora')?.style.getPropertyValue('--aurora-energy');
    expect(energy()).toBe('0');
    rerender(<OverlayWaveformView levels={Array<number>(24).fill(0.5)} waveform="speaking" />);
    expect(energy()).toBe('0.5');
    rerender(<OverlayWaveformView levels={Array<number>(24).fill(9)} waveform="speaking" />);
    expect(energy()).toBe('1');
    const malformed = [NaN, Infinity, -Infinity, -1, 9, 0.5];
    rerender(<OverlayWaveformView levels={malformed} waveform="speaking" />);
    expect(energy()).toBe('0.0625'); // (1 + .5) / 24 displayed bars; missing bars are silent.
    expect([...container.querySelectorAll<HTMLElement>('.wave i')].map((bar) => bar.style.getPropertyValue('--h')))
      .toEqual(['1px', '1px', '1px', '1px', '13px', '7px', ...Array<string>(18).fill('1px')]);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
    expect(malformed[4]).toBe(9); // Never mutate the display history supplied by the session.
    rerender(<OverlayWaveformView levels={[...Array<number>(24).fill(0), 1]} waveform="silent" />);
    expect(energy()).toBe('0'); // Only the visible 24 bars contribute.
  });

  it('decorates only silent/speaking without replacing bars or adding announcements', () => {
    const levels = Array<number>(24).fill(0.5);
    const { container, rerender } = render(<OverlayWaveformView levels={levels} waveform="silent" />);
    const status = screen.getByRole('status');
    for (const waveform of ['silent', 'speaking'] as const) {
      rerender(<OverlayWaveformView levels={levels} waveform={waveform} />);
      const aurora = container.querySelector('.hud-aurora');
      expect(aurora).not.toBeNull();
      expect(aurora).toHaveAttribute('aria-hidden', 'true');
      expect(aurora?.textContent).toBe('');
      expect(screen.getByRole('img', { name: 'Microphone level' }).querySelectorAll('i')).toHaveLength(24);
      expect(screen.getAllByRole('status')).toEqual([status]);
      expect(status).toHaveTextContent('');
      expect(container.querySelector('button, input, [tabindex]')).toBeNull();
    }
    rerender(<OverlayWaveformView levels={levels} waveform="processing" />);
    expect(container.querySelector('.hud-aurora')).toBeNull();
    expect(container.querySelector('.hud-transcribing')).not.toBeNull();
    expect(status).toHaveTextContent('Transcribing');
    for (const [waveform, result, announcement] of [
      ['result-copied', 'copied', 'Copied. Press Command V to paste'],
      ['result-unverified', 'maybe-copied', 'May have been inserted; also copied. If it\'s missing, press Command V to paste.'],
      ['result-failed', 'insert-failed', 'Couldn’t insert'],
      ['result-failed', 'transcribe-failed', 'Couldn’t transcribe'],
    ] as const) {
      rerender(<OverlayWaveformView levels={levels} mac result={result} waveform={waveform} />);
      expect(container.querySelector('.hud-aurora')).toBeNull();
      expect(screen.getByRole('status')).toBe(status);
      expect(status).toHaveTextContent(announcement);
    }
  });
});

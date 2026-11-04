import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OverlayWaveformView } from '../../src/overlay/OverlayWaveformView';
import type { OverlayResult, OverlayWaveform } from '../../src/services/shortcut/overlayVisibility';

const levels = Array<number>(24).fill(0.5);

describe('Plasma listening HUD', () => {
  it('adds a decorative electric filament without replacing the microphone bars or live region', () => {
    const { container } = render(<OverlayWaveformView levels={levels} waveform="speaking" />);
    const plasma = container.querySelector('.hud-plasma');
    expect(plasma).not.toBeNull();
    expect(plasma).toHaveAttribute('aria-hidden', 'true');
    expect(plasma).toHaveAttribute('focusable', 'false');
    expect(plasma?.querySelectorAll('path')).toHaveLength(3);
    expect(screen.getByRole('img', { name: 'Microphone level' }).querySelectorAll('i')).toHaveLength(24);
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('swells filament displacement and brightness from display levels, not the speaking label', () => {
    const { container, rerender } = render(<OverlayWaveformView levels={[]} waveform="silent" />);
    const filament = () => container.querySelector<SVGSVGElement>('.hud-plasma')!;
    const quietPath = filament().querySelector('path')!.getAttribute('d');
    const quietOpacity = Number(filament().style.opacity);
    rerender(<OverlayWaveformView levels={Array<number>(24).fill(1)} waveform="silent" />);
    expect(Number(filament().style.opacity)).toBeGreaterThan(quietOpacity);
    expect(filament().querySelector('path')!.getAttribute('d')).not.toBe(quietPath);
    const loudPath = filament().querySelector('path')!.getAttribute('d');
    rerender(<OverlayWaveformView levels={Array<number>(24).fill(1)} waveform="speaking" />);
    expect(filament().querySelector('path')!.getAttribute('d')).toBe(loudPath);
  });

  it('clamps invalid display samples for both the filament and the existing bars', () => {
    const malformed = [NaN, Infinity, -Infinity, -2, 3, 0.5, undefined as unknown as number];
    const { container, rerender } = render(<OverlayWaveformView levels={malformed} waveform="speaking" />);
    const plasma = () => container.querySelector('.hud-plasma')!.outerHTML;
    expect([...screen.getByRole('img').querySelectorAll('i')].slice(0, 7).map((bar) => bar.style.getPropertyValue('--h')))
      .toEqual(['1px', '1px', '1px', '1px', '13px', '7px', '1px']);
    const bounded = plasma();
    expect(bounded).not.toMatch(/NaN|Infinity/);
    rerender(<OverlayWaveformView levels={[0, 0, 0, 0, 1, 0.5, 0]} waveform="speaking" />);
    expect(plasma()).toBe(bounded);
  });

  it.each<[OverlayWaveform, OverlayResult | null, string]>([
    ['silent', null, ''],
    ['speaking', null, ''],
    ['processing', null, 'Transcribing'],
    ['result-copied', 'copied', 'Copied. Press Command V to paste'],
    ['result-unverified', 'maybe-copied', 'May have been inserted; also copied'],
    ['result-failed', 'insert-failed', 'Couldn’t insert'],
    ['result-failed', 'transcribe-failed', 'Couldn’t transcribe'],
  ])('gates plasma for %s / %s without changing announcements', (waveform, result, spoken) => {
    const { container } = render(<OverlayWaveformView levels={levels} mac result={result} waveform={waveform} />);
    expect(Boolean(container.querySelector('.hud-plasma'))).toBe(waveform === 'silent' || waveform === 'speaking');
    expect(screen.getByRole('status').textContent).toContain(spoken);
    if (waveform === 'processing') expect(container.querySelector('.hud-transcribing i')).not.toBeNull();
    if (waveform.startsWith('result-')) expect(container.querySelector('.hud-result')).toHaveAttribute('aria-hidden', 'true');
  });
});

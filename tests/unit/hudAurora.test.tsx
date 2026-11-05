import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OverlayWaveformView } from '../../src/overlay/OverlayWaveformView';

describe('Aurora listening decoration', () => {
  it('sets reactive energy to the mean of the 24-bar display history', () => {
    const { container, rerender } = render(<OverlayWaveformView levels={[]} waveform="silent" />);
    const energy = () => container.querySelector<HTMLElement>('.hud-aurora')?.style.getPropertyValue('--aurora-energy');
    expect(energy()).toBe('0');
    rerender(<OverlayWaveformView levels={Array<number>(24).fill(0.5)} waveform="speaking" />);
    expect(energy()).toBe('0.5');
    rerender(<OverlayWaveformView levels={[...Array<number>(18).fill(0), ...Array<number>(6).fill(1)]} waveform="speaking" />);
    expect(energy()).toBe('0.25');
    rerender(<OverlayWaveformView levels={Array<number>(24).fill(1)} waveform="speaking" />);
    expect(energy()).toBe('1');
  });

  it('retains the listening decoration during processing without replacing its nodes or live region', () => {
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
    const pill = container.querySelector('.recording--overlay');
    const aurora = container.querySelector<HTMLElement>('.hud-aurora');
    const decorationNodes = [...aurora!.querySelectorAll('*')];
    rerender(<OverlayWaveformView levels={levels} waveform="processing" />);
    expect(container.querySelector('.recording--overlay')).toBe(pill);
    expect(container.querySelector('.hud-aurora')).toBe(aurora);
    expect(aurora).toHaveStyle('--aurora-energy: 0.5');
    const processingNodes = [...container.querySelectorAll('.hud-aurora *')];
    expect(processingNodes).toHaveLength(decorationNodes.length);
    processingNodes.forEach((node, index) => expect(node).toBe(decorationNodes[index]));
    expect(container.querySelector('.wave')).toBeNull();
    expect(container.querySelectorAll('.hud-transcribing')).toHaveLength(1);
    expect(container.querySelector('.hud-transcribing')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('button, input, [tabindex]')).toBeNull();
    expect(screen.getAllByRole('status')).toEqual([status]);
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

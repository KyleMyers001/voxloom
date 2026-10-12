/// UI PR 8: HUD behavior rules (SPEC § HUD) — view, result timing, mapping, motion.
import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverlayWaveformView } from '../../src/overlay/OverlayWaveformView';
import { createOverlayBridge } from '../../src/services/shortcut/overlayBridge';
import { hudResultFor } from '../../src/services/stt/useDogfoodCapture';

const levels = Array<number>(24).fill(0.5);

function api() {
  return {
    ensureCreated: vi.fn().mockResolvedValue(undefined),
    hide: vi.fn().mockResolvedValue(undefined),
    isAvailable: () => true,
    setWaveform: vi.fn().mockResolvedValue(undefined),
    showBottomCenter: vi.fn().mockResolvedValue(undefined),
  };
}

afterEach(() => vi.useRealTimers());

describe('HUD view', () => {
  it('shows no text while listening or transcribing', () => {
    const { container, rerender } = render(<OverlayWaveformView levels={levels} waveform="speaking" />);
    expect(container.textContent).toBe('');
    expect(screen.getByRole('img', { name: 'Microphone level' })).toBeInTheDocument();
    rerender(<OverlayWaveformView levels={levels} waveform="processing" />);
    expect(container.textContent).toBe('');
    expect(screen.getByRole('img', { name: 'Transcribing' })).toHaveClass('hud-transcribing');
  });

  it('shows only a brief Copied or short error', () => {
    const { rerender } = render(<OverlayWaveformView levels={levels} result="copied" waveform="result-copied" />);
    expect(screen.getByRole('status')).toHaveTextContent('Copied. Press ⌘V to paste');
    rerender(<OverlayWaveformView levels={levels} result="transcribe-failed" waveform="result-failed" />);
    expect(screen.getByRole('status')).toHaveTextContent('Couldn’t transcribe');
    rerender(<OverlayWaveformView levels={levels} result="insert-failed" waveform="result-failed" />);
    expect(screen.getByRole('status')).toHaveTextContent('Couldn’t insert');
  });
});

describe('hudResultFor (rules 3–6)', () => {
  it('maps delivery status to a HUD result', () => {
    expect(hudResultFor('inserted')).toBeNull();
    expect(hudResultFor('unverified')).toBeNull();
    expect(hudResultFor('copied')).toBe('copied');
    expect(hudResultFor('failed')).toBe('insert-failed');
  });
});

describe('overlayBridge.showResult', () => {
  it('shows Copied wide for 1.5 s, holding off the teardown hide, then hides', async () => {
    vi.useFakeTimers();
    const window = api();
    const bridge = createOverlayBridge(window);
    await bridge.showResult('copied');
    expect(window.setWaveform).toHaveBeenCalledWith('result-copied', 'copied');
    expect(window.showBottomCenter).toHaveBeenCalledWith({ height: 40, width: 248 });
    await bridge.sync({ kind: 'ready' });
    expect(window.hide).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1499);
    expect(window.hide).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(window.hide).toHaveBeenCalledOnce();
  });

  it('holds a failure for 2.5 s', async () => {
    vi.useFakeTimers();
    const window = api();
    const bridge = createOverlayBridge(window);
    await bridge.showResult('transcribe-failed');
    expect(window.setWaveform).toHaveBeenCalledWith('result-failed', 'transcribe-failed');
    await vi.advanceTimersByTimeAsync(2499);
    expect(window.hide).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(window.hide).toHaveBeenCalledOnce();
  });

  it('a new listening run replaces the result at once at the listening size', async () => {
    vi.useFakeTimers();
    const window = api();
    const bridge = createOverlayBridge(window);
    await bridge.showResult('copied');
    await bridge.sync({ kind: 'listening', runId: 2, waveform: 'silent' });
    expect(window.setWaveform).toHaveBeenLastCalledWith('silent');
    expect(window.showBottomCenter).toHaveBeenLastCalledWith({ height: 28, width: 142 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(window.hide).not.toHaveBeenCalled();
  });
});

describe('HUD motion (Option A)', () => {
  const css = readFileSync('src/styles/hud.css', 'utf8');
  it('shimmers and pulses on a 1.6 s cycle', () => {
    expect(css).toMatch(/animation: hud-shimmer 1\.6s linear infinite, hud-pulse 1\.6s ease-in-out infinite/);
  });
  it('falls back to a slow 3 s opacity breathe under Reduce Motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.hud-transcribing i \{ animation: hud-breathe 3s ease-in-out infinite; \}/);
  });
});

describe('HUD sizing (no jump between listening and transcribing)', () => {
  const css = readFileSync('src/styles/hud.css', 'utf8');
  it('uses one 118px row for the waveform and the transcribing row', () => {
    expect(css).toMatch(/\.recording--overlay \.wave \{[^}]*width: 118px/);
    expect(css).toMatch(/\.hud-transcribing \{[^}]*width: 118px/);
  });
});

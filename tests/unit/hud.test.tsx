/// UI PR 8: HUD behavior rules (SPEC § HUD) — view, result timing, mapping, motion.
import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverlayWaveformView, resultText, spokenResultText } from '../../src/overlay/OverlayWaveformView';
import { createOverlayBridge } from '../../src/services/shortcut/overlayBridge';
import { resultWaveform } from '../../src/services/shortcut/overlayVisibility';
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
  const visible = (c: HTMLElement) => [...c.children].filter((n) => !n.classList.contains('sr-only'))
    .map((n) => n.textContent).join('');

  it('shows no text while listening or transcribing', () => {
    const { container, rerender } = render(<OverlayWaveformView levels={levels} waveform="speaking" />);
    expect(visible(container)).toBe('');
    expect(screen.getByRole('status')).toHaveTextContent('');
    rerender(<OverlayWaveformView levels={levels} waveform="processing" />);
    expect(visible(container)).toBe('');
    expect(container.querySelector('.hud-transcribing')).not.toBeNull();
  });

  it('keeps one permanent live region that announces Transcribing and results', () => {
    const { rerender } = render(<OverlayWaveformView levels={levels} waveform="silent" />);
    const live = screen.getByRole('status');
    rerender(<OverlayWaveformView levels={levels} waveform="processing" />);
    expect(screen.getByRole('status')).toBe(live);
    expect(live).toHaveTextContent('Transcribing');
    rerender(<OverlayWaveformView levels={levels} mac result="copied" waveform="result-copied" />);
    expect(screen.getByRole('status')).toBe(live);
    expect(live).toHaveTextContent('Copied. Press ⌘V to paste');
  });

  it('shows only a brief Copied, maybe-copied or short error, with the platform paste key', () => {
    expect(resultText('copied', true)).toBe('Copied · ⌘V to paste');
    expect(resultText('copied', false)).toBe('Copied · Ctrl+V to paste');
    // The live region keeps the full sentence.
    expect(spokenResultText('copied', true)).toBe('Copied. Press ⌘V to paste');
    expect(spokenResultText('copied', false)).toBe('Copied. Press Ctrl+V to paste');
    expect(resultText('maybe-copied', true)).toBe('Maybe inserted · copied');
    // The spoken text keeps the pill's meaning (QA #44).
    expect(spokenResultText('maybe-copied', true)).toBe('May have been inserted; also copied. If it\'s missing, press Command V to paste.');
    expect(resultText('transcribe-failed')).toBe('Couldn’t transcribe');
    expect(resultText('insert-failed')).toBe('Couldn’t insert');
    const { container } = render(<OverlayWaveformView levels={levels} mac result="maybe-copied" waveform={resultWaveform('maybe-copied')} />);
    expect(container.querySelector('.hud-result--unverified')).toHaveTextContent('Maybe inserted · copied');
    expect(screen.getByRole('status')).toHaveTextContent('May have been inserted; also copied');
  });

  it('unverified and may-have-inserted (nothing copied) dismiss silently, like a success (Kyle)', () => {
    expect(hudResultFor({ status: 'unverified' })).toBeNull();
    expect(hudResultFor({ mayHaveInserted: true, status: 'failed' })).toBeNull();
    // A null result never reaches overlayBridge.showResult, so there is no pill and no announcement.
  });
});

describe('hudResultFor (rules 3–6 + review)', () => {
  it('maps delivery status to a HUD result', () => {
    expect(hudResultFor({ status: 'inserted' })).toBeNull();
    expect(hudResultFor({ status: 'unverified' })).toBeNull();
    expect(hudResultFor({ status: 'copied' })).toBe('copied');
    expect(hudResultFor({ mayHaveInserted: true, status: 'copied' })).toBe('maybe-copied');
    expect(hudResultFor({ status: 'failed' })).toBe('insert-failed');
    // Review #44: an unconfirmed write with nothing copied is NOT "Couldn't insert"; it dismisses silently.
    expect(hudResultFor({ mayHaveInserted: true, status: 'failed' })).toBeNull();
  });

  it('reads the flag, never the message text', () => {
    expect(hudResultFor({ message: 'May have been inserted — also copied', status: 'copied' } as never)).toBe('copied');
  });
});

describe('overlayBridge.showResult', () => {
  it('shows Copied wide for 2.5 s, holding off the teardown hide, then hides', async () => {
    vi.useFakeTimers();
    const window = api();
    const bridge = createOverlayBridge(window);
    await bridge.showResult('copied');
    expect(window.setWaveform).toHaveBeenCalledWith('result-copied', 'copied');
    expect(window.showBottomCenter).toHaveBeenCalledWith({ height: 40, width: 248 });
    await bridge.sync({ kind: 'ready' });
    expect(window.hide).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2499);
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
  it('pulses on 1.6 s and shimmers with a transform, not background-position', () => {
    expect(css).toMatch(/\.hud-transcribing \{[^}]*animation: hud-pulse 1\.6s ease-in-out infinite/);
    expect(css).toMatch(/\.hud-transcribing i \{[^}]*animation: hud-shimmer 1\.6s linear infinite/);
    expect(css).toMatch(/@keyframes hud-shimmer \{ to \{ transform: translateX\(-50%\); \} \}/);
    expect(css).not.toMatch(/background-position/);
  });
  it('uses whole rounded bars (no half cap at either end)', () => {
    expect(css).toMatch(/rect width='3' height='6' rx='1\.5'/);
    expect(css).toMatch(/\/ 5px 6px repeat-x/);
    expect((118 + 2) % 5).toBe(0); // 24 bars × 3px + 23 gaps × 2px
  });
  it('falls back to a slow 3 s opacity breathe under Reduce Motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.hud-transcribing \{ animation: hud-breathe 3s ease-in-out infinite; \}\s*\.hud-transcribing i \{ animation: none; \}/);
  });
});

describe('HUD sizing (no jump between listening and transcribing)', () => {
  const css = readFileSync('src/styles/hud.css', 'utf8');
  it('uses one 118px row for the waveform and the transcribing row', () => {
    expect(css).toMatch(/\.recording--overlay \.wave \{[^}]*width: 118px/);
    expect(css).toMatch(/\.hud-transcribing \{[^}]*width: 118px/);
  });
});

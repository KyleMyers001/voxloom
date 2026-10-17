import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DictateCard } from '../../src/features/home/DictateCard';
import {
  cancelSettingsPane,
  cancelUnavailableFrom,
  cancelUnavailableHint,
  type CancelUnavailable,
} from '../../src/services/shortcut/cancelUnavailable';
import { openPrivacyPane } from '../../src/services/shortcut/privacyPane';
import type { UseDogfoodCaptureResult } from '../../src/services/stt/useDogfoodCapture';

vi.mock('../../src/services/shortcut/privacyPane', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/shortcut/privacyPane')>(),
  openPrivacyPane: vi.fn(),
}));
vi.mock('../../src/app/AppContext', () => ({
  useApp: () => ({ state: { settings: { transcriptionModel: 'tiny', clipboardFallback: true } } }),
}));

function recording(
  cancelUnavailable: CancelUnavailable | null,
  message: string | null = 'Listening…',
): UseDogfoodCaptureResult {
  return {
    phase: 'recording', message, captureState: { kind: 'idle' }, cancelUnavailable,
    scopeReady: false, hudReady: false, intendedTarget: null, hudResult: null, origin: 'gesture',
    transcript: null, cancel: vi.fn(), start: vi.fn(), stop: vi.fn(),
  };
}

describe('cancellation diagnostics on Home', () => {
  beforeEach(() => {
    vi.mocked(openPrivacyPane).mockReset();
    vi.mocked(openPrivacyPane).mockResolvedValue(undefined);
  });

  it.each([
    ['cancel-ax-untrusted', /Accessibility permission/],
    ['cancel-listen-denied', /Input Monitoring permission/],
    ['cancel-tap-create-failed', /could not start the Escape listener/],
  ] as const)('shows a non-blocking %s hint and copies details only on request', (code, hint) => {
    const details = `Escape cancellation unavailable [${code}]. (ax=true listen=false post=true; app=com.voxloom.prototype version=0.1.0)`;
    const onCopy = vi.fn();
    render(<DictateCard dogfood={recording({ code, details })} isNative onCopy={onCopy} />);
    expect(screen.getByText(hint)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    expect(onCopy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Copy error details' }));
    expect(onCopy).toHaveBeenCalledExactlyOnceWith(details);
  });

  it('keys the details button on the structured code, not on status text', () => {
    const lookalike = 'Escape cancellation unavailable [cancel-ax-untrusted].';
    render(<DictateCard dogfood={recording(null, lookalike)} isNative onCopy={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Copy error details' })).not.toBeInTheDocument();
  });

  it('reads the native { code, message } rejection and falls back for unknown errors', () => {
    expect(cancelUnavailableFrom({ code: 'cancel-ax-untrusted', message: 'full text' }))
      .toEqual({ code: 'cancel-ax-untrusted', details: 'full text' });
    expect(cancelUnavailableFrom({ code: 'something-else', message: 'x' }).code).toBe('cancel-arm-failed');
    expect(cancelUnavailableFrom('Escape scope must run on the main thread'))
      .toEqual({ code: 'cancel-arm-failed', details: 'Escape scope must run on the main thread' });
  });

  it.each([
    ['cancel-ax-untrusted', 'accessibility'],
    ['cancel-listen-denied', 'input-monitoring'],
    ['cancel-tap-create-failed', null],
    ['cancel-arm-failed', null],
  ] as const)('maps %s to the %s Settings pane', (code, pane) => {
    expect(cancelSettingsPane(code)).toBe(pane);
  });

  it('gives every code its own hint', () => {
    const hints = (['cancel-ax-untrusted', 'cancel-listen-denied', 'cancel-tap-create-failed'] as const)
      .map(cancelUnavailableHint);
    expect(new Set(hints).size).toBe(3);
    expect(cancelUnavailableHint('cancel-listen-denied'))
      .toBe('Escape-cancel is off: Voxloom does not have Input Monitoring permission. Dictation still works.');
  });

  it.each([
    ['cancel-ax-untrusted', 'accessibility'],
    ['cancel-listen-denied', 'input-monitoring'],
  ] as const)('Open Settings for %s opens the %s pane', (code, pane) => {
    render(<DictateCard dogfood={recording({ code, details: code })} isNative onCopy={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(openPrivacyPane).toHaveBeenCalledExactlyOnceWith(pane);
  });

  it.each(['cancel-tap-create-failed', 'cancel-arm-failed'] as const)(
    'hides Open Settings for %s (no single pane to fix)', (code) => {
      render(<DictateCard dogfood={recording({ code, details: code })} isNative onCopy={vi.fn()} />);
      expect(screen.queryByRole('button', { name: 'Open Settings' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Copy error details' })).toBeInTheDocument();
    });

  it('says where to go by hand when System Settings cannot be opened', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(openPrivacyPane).mockRejectedValue(new Error('open failed'));
    render(<DictateCard dogfood={recording({ code: 'cancel-listen-denied', details: 'x' })} isNative onCopy={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(await screen.findByText(
      'Could not open System Settings. Open Privacy & Security → Input Monitoring and allow Voxloom.',
    )).toBeInTheDocument();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('reads the new listen-denied code from the native rejection', () => {
    expect(cancelUnavailableFrom({ code: 'cancel-listen-denied', message: 'full' }))
      .toEqual({ code: 'cancel-listen-denied', details: 'full' });
  });
});

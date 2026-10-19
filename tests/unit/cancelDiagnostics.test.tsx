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
    ['cancel-tap-create-failed', null],
    ['cancel-arm-failed', null],
  ] as const)('maps %s to the %s Settings pane', (code, pane) => {
    expect(cancelSettingsPane(code)).toBe(pane);
  });

  it('gives every code its own hint and asks for a relaunch only for permission', () => {
    const codes = ['cancel-ax-untrusted', 'cancel-tap-create-failed', 'cancel-arm-failed'] as const;
    const hints = codes.map(cancelUnavailableHint);
    expect(hints[0]).toBe('Escape-cancel is off: Voxloom doesn\'t have Accessibility permission. '
      + 'Dictation still works. After you allow it, quit and reopen Voxloom.');
    expect(hints[1]).not.toMatch(/quit and reopen/);
    expect(hints.join(' ')).not.toMatch(/Input Monitoring/);
  });

  it('Open System Settings for cancel-ax-untrusted opens the Accessibility pane', () => {
    render(<DictateCard dogfood={recording({ code: 'cancel-ax-untrusted', details: 'x' })} isNative onCopy={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open System Settings' }));
    expect(openPrivacyPane).toHaveBeenCalledExactlyOnceWith('accessibility');
  });

  it.each(['cancel-tap-create-failed', 'cancel-arm-failed'] as const)(
    'hides Open System Settings for %s (no single pane to fix)', (code) => {
      render(<DictateCard dogfood={recording({ code, details: code })} isNative onCopy={vi.fn()} />);
      expect(screen.queryByRole('button', { name: 'Open System Settings' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Copy error details' })).toBeInTheDocument();
    });

  it('says where to go by hand when System Settings cannot be opened', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(openPrivacyPane).mockRejectedValue(new Error('open failed'));
    render(<DictateCard dogfood={recording({ code: 'cancel-ax-untrusted', details: 'x' })} isNative onCopy={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open System Settings' }));
    expect(await screen.findByText(
      'Couldn\'t open System Settings. Open it, go to Privacy & Security, then Accessibility, and allow Voxloom.',
    )).toBeInTheDocument();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('treats an unknown or retired code as a generic arm failure', () => {
    expect(cancelUnavailableFrom({ code: 'cancel-listen-denied', message: 'full' }).code)
      .toBe('cancel-arm-failed');
  });
});

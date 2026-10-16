import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DictateCard } from '../../src/features/home/DictateCard';
import {
  cancelUnavailableFrom,
  type CancelUnavailable,
} from '../../src/services/shortcut/cancelUnavailable';
import type { UseDogfoodCaptureResult } from '../../src/services/stt/useDogfoodCapture';

vi.mock('../../src/app/AppContext', () => ({
  useApp: () => ({ state: { settings: { transcriptionModel: 'tiny', clipboardFallback: true } } }),
}));

function recording(
  cancelUnavailable: CancelUnavailable | null,
  message: string | null = 'Listening…',
): UseDogfoodCaptureResult {
  return {
    phase: 'recording', message, captureState: { kind: 'idle' }, cancelUnavailable,
    scopeReady: false, intendedTarget: null, hudResult: null, origin: 'gesture',
    transcript: null, cancel: vi.fn(), start: vi.fn(), stop: vi.fn(),
  };
}

describe('cancellation diagnostics on Home', () => {
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
});

/** BUS-91: which capture terminal events a dogfood session acts on. */
import { act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptureState } from '../../../src/services/capture/types';
import { deferred, EMPTY_STOP, emptyStop, micLost, setup } from './dogfoodHarness';

afterEach(() => { vi.restoreAllMocks(); });

describe('capture terminal events and the live session (BUS-91)', () => {
  it('a quick tap\'s empty stop does not end the re-hold that follows', async () => {
    const { capture, escape, onErrorToast, rerender, result } = await setup();
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    const release = deferred<void>();
    vi.mocked(capture.waitForCaptureRelease).mockReturnValueOnce(release.promise);
    let rehold!: Promise<void>;
    act(() => { rehold = result.current.start(); });
    await waitFor(() => expect(capture.waitForCaptureRelease).toHaveBeenCalledTimes(2));
    // The tap's capture ends with nothing recorded while the re-hold waits.
    rerender({ state: emptyStop });
    expect(result.current.phase).not.toBe('error');
    await act(async () => { release.settle(); await rehold; });
    expect(result.current.phase).toBe('recording');
    expect(onErrorToast).not.toHaveBeenCalledWith(EMPTY_STOP);
    expect(escape()).toBe(true);
    expect(result.current.phase).toBe('cancelled');
  });

  it('an empty stop from a cancelled session is ignored', async () => {
    const { escape, onErrorToast, rerender, result } = await setup();
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    expect(escape()).toBe(true);
    rerender({ state: emptyStop });
    expect(result.current.phase).toBe('cancelled');
    expect(onErrorToast).not.toHaveBeenCalledWith(EMPTY_STOP);
  });

  it('the current session\'s own empty stop still reports an error', async () => {
    const { onErrorToast, rerender, result } = await setup();
    await act(async () => { await result.current.start(); });
    rerender({ state: emptyStop });
    expect(result.current.phase).toBe('error');
    expect(onErrorToast).toHaveBeenCalledExactlyOnceWith(EMPTY_STOP);
  });

  it.each([
    [{ kind: 'cancelled' } as CaptureState, 'cancelled', 'Capture cancelled — nothing transcribed.'],
    [micLost, 'error', 'mic lost'],
  ] as const)('the session\'s own %o ends it while its start is pending', async (state, phase, message) => {
    const { capture, rerender, result } = await setup();
    const started = deferred<'ended'>();
    vi.mocked(capture.startFullCaptureSession).mockReturnValueOnce(started.promise);
    let start!: Promise<void>;
    act(() => { start = result.current.start(); });
    await waitFor(() => expect(capture.startFullCaptureSession).toHaveBeenCalledOnce());
    rerender({ state });
    expect(result.current.phase).toBe(phase);
    expect(result.current.message).toBe(message);
    await act(async () => { started.settle('ended'); await start; });
    expect(result.current.phase).toBe(phase);
  });

  it('with no live session, an older capture\'s error is still shown', async () => {
    const { escape, rerender, result } = await setup();
    await act(async () => { await result.current.start(); });
    expect(escape()).toBe(true);
    rerender({ state: micLost });
    expect(result.current.phase).toBe('error');
    expect(result.current.message).toBe('mic lost');
  });
});

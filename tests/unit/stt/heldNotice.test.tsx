/** BUS-91: a held "replaced" notice survives a re-hold that never listens. */
import { act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUPERSEDED_DELIVERY_MESSAGE } from '../../../src/services/delivery';
import * as cancelScopeModule from '../../../src/services/shortcut/cancelScope';
import { deferred, setup, tapClip } from './dogfoodHarness';

afterEach(() => { vi.restoreAllMocks(); });

/** Tap, re-hold, and the tap's audio processed while the re-hold still starts. */
async function heldDuringStart() {
  const hook = await setup({ subscribe: true });
  await act(async () => { await hook.result.current.start(); });
  await act(async () => { await hook.result.current.stop(); });
  const release = deferred<void>();
  vi.mocked(hook.capture.waitForCaptureRelease).mockReturnValueOnce(release.promise);
  let rehold!: Promise<void>;
  act(() => { rehold = hook.result.current.start('gesture'); });
  hook.emitStop(tapClip, 0);
  await waitFor(() => expect(hook.onHistoryRecord).toHaveBeenCalledOnce());
  expect(hook.onToast).not.toHaveBeenCalledWith(SUPERSEDED_DELIVERY_MESSAGE);
  return { ...hook, rehold, release };
}

describe('held replaced notice (BUS-91)', () => {
  it('joins the failure toast when the re-hold cannot start', async () => {
    const { capture, onErrorToast, rehold, release } = await heldDuringStart();
    vi.mocked(capture.startFullCaptureSession).mockResolvedValueOnce('error');
    await act(async () => { release.settle(); await rehold; });
    expect(onErrorToast).toHaveBeenLastCalledWith(
      `Microphone capture could not start. Check permission and retry. ${SUPERSEDED_DELIVERY_MESSAGE}`);
  });

  it('shows when the re-hold is cancelled while starting', async () => {
    const { onToast, rehold, release, result } = await heldDuringStart();
    act(() => result.current.cancel());
    expect(onToast).toHaveBeenLastCalledWith(SUPERSEDED_DELIVERY_MESSAGE);
    await act(async () => { release.settle(); await rehold; });
  });

  it('carries over to a third hold and shows after its "Listening…"', async () => {
    const { onToast, rehold, release, result } = await heldDuringStart();
    let third!: Promise<void>;
    act(() => { third = result.current.start('gesture'); });
    await act(async () => { release.settle(); await rehold; await third; });
    expect(result.current.phase).toBe('recording');
    expect(onToast.mock.calls.map(([text]) => text).slice(-2))
      .toEqual(['Listening…', SUPERSEDED_DELIVERY_MESSAGE]);
  });
});

describe('superseded Escape arm failure (Codex 4318632423)', () => {
  it('an older start\'s late arm failure does not replace the newer report', async () => {
    const { result } = await setup();
    let rejectArm!: (error: unknown) => void;
    const pending = new Promise<never>((_, reject) => { rejectArm = reject; });
    vi.mocked(cancelScopeModule.beginCancelScope).mockImplementationOnce(() => pending);
    let older!: Promise<void>;
    act(() => { older = result.current.start(); });
    await waitFor(() => expect(cancelScopeModule.beginCancelScope).toHaveBeenCalledOnce());
    await act(async () => { await result.current.start(); });
    expect(result.current.phase).toBe('recording');
    await act(async () => {
      rejectArm({ code: 'cancel-ax-untrusted', message: 'stale' });
      await older;
    });
    expect(result.current.cancelUnavailable).toBeNull();
  });
});

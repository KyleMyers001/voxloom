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
  const release = deferred<boolean>();
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
    await act(async () => { release.settle(true); await rehold; });
    expect(onErrorToast).toHaveBeenLastCalledWith(
      `Microphone capture could not start. Check permission and retry. ${SUPERSEDED_DELIVERY_MESSAGE}`);
  });

  it('is dropped when the user cancels the re-hold while starting', async () => {
    const { onHistoryRecord, onToast, rehold, release, result } = await heldDuringStart();
    act(() => result.current.cancel());
    await act(async () => { release.settle(true); await rehold; });
    expect(onToast).not.toHaveBeenCalledWith(expect.stringContaining(SUPERSEDED_DELIVERY_MESSAGE));
    expect(onHistoryRecord.mock.calls[0][0]).toMatchObject({ status: 'failed', text: 'tap words' });
    // ... and does not resurface after the next hold's "Listening…".
    await act(async () => { await result.current.start('gesture'); });
    expect(onToast.mock.lastCall?.[0]).toBe('Listening…');
  });

  it('shows when the re-hold is released before its mic opened', async () => {
    const { onToast, rehold, release, result } = await heldDuringStart();
    await act(async () => { await result.current.stop(); });
    await act(async () => { release.settle(true); await rehold; });
    expect(result.current.phase).toBe('cancelled');
    expect(onToast).toHaveBeenLastCalledWith(SUPERSEDED_DELIVERY_MESSAGE);
  });

  it('joins a start failure that came first, in the error tone', async () => {
    const { capture, emitStop, onErrorToast, onToast, result } = await setup({ subscribe: true });
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    vi.mocked(capture.startFullCaptureSession).mockResolvedValueOnce('error');
    await act(async () => { await result.current.start('gesture'); });
    const failure = 'Microphone capture could not start. Check permission and retry.';
    expect(onErrorToast).toHaveBeenLastCalledWith(failure);
    emitStop(tapClip, 0);
    await waitFor(() => expect(onErrorToast).toHaveBeenLastCalledWith(`${failure} ${SUPERSEDED_DELIVERY_MESSAGE}`));
    expect(onToast).not.toHaveBeenCalledWith(expect.stringContaining(SUPERSEDED_DELIVERY_MESSAGE));
  });

  it('joins the Escape-cancel hint still on screen instead of replacing it', async () => {
    const { emitStop, onToast, result } = await setup({ subscribe: true });
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    vi.mocked(cancelScopeModule.beginCancelScope)
      .mockRejectedValueOnce({ code: 'cancel-tap-create-failed', message: 'no tap' });
    await act(async () => { await result.current.start('gesture'); });
    const hint = onToast.mock.lastCall?.[0] ?? '';
    expect(hint).toMatch(/^Escape-cancel is off/);
    emitStop(tapClip, 0);
    await waitFor(() => expect(onToast).toHaveBeenLastCalledWith(`${hint} ${SUPERSEDED_DELIVERY_MESSAGE}`));
  });

  it('carries over to a third hold and shows after its "Listening…"', async () => {
    const { onToast, rehold, release, result } = await heldDuringStart();
    let third!: Promise<void>;
    act(() => { third = result.current.start('gesture'); });
    await act(async () => { release.settle(true); await rehold; await third; });
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

/** BUS-91: a re-hold after a quick tap supersedes the tap; it never cancels it. */
import { act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUPERSEDED_DELIVERY_MESSAGE } from '../../../src/services/delivery';
import { retireScope, type Cancellation } from '../../../src/services/stt/dogfoodSessionState';
import { deferred, setup, tapClip } from './dogfoodHarness';

afterEach(() => { vi.restoreAllMocks(); });

type Hook = Awaited<ReturnType<typeof setup>>['result'];
/** Exactly what the shortcut handler does on hold-start. */
function holdAgain(result: Hook) {
  const dogfood = result.current;
  if (dogfood.phase === 'recording' && !dogfood.stopRequested?.()) dogfood.cancel();
  return dogfood.start('gesture');
}

describe('re-hold after a quick tap (BUS-91)', () => {
  it('the tap\'s stop audio arrives before the re-hold starts', async () => {
    const { emitStop, insert, onHistoryRecord, onToast, result, transcribe } =
      await setup({ subscribe: true });
    const stt = deferred<{ language: string; text: string }>();
    transcribe.mockReturnValueOnce(stt.promise);
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    emitStop(tapClip, 0);
    await waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
    await act(async () => { await holdAgain(result); });
    expect(result.current.phase).toBe('recording');
    await act(async () => { stt.settle({ language: 'en', text: 'tap words' }); });
    await waitFor(() => expect(onHistoryRecord).toHaveBeenCalledOnce());
    expect(onHistoryRecord.mock.calls[0][0]).toMatchObject({ status: 'failed', text: 'tap words' });
    expect(insert).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenLastCalledWith(SUPERSEDED_DELIVERY_MESSAGE);
    expect(result.current.phase).toBe('recording');
  });

  it('the tap\'s stop audio arrives after the re-hold started', async () => {
    const { capture, emitStop, insert, onHistoryRecord, onToast, result, scopes } =
      await setup({ subscribe: true });
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    const release = deferred<void>();
    vi.mocked(capture.waitForCaptureRelease).mockReturnValueOnce(release.promise);
    let rehold!: Promise<void>;
    act(() => { rehold = holdAgain(result); });
    expect(capture.cancelActiveCapture).not.toHaveBeenCalled();
    await waitFor(() => expect(capture.waitForCaptureRelease).toHaveBeenCalledTimes(2));
    emitStop(tapClip, 0);
    await waitFor(() => expect(onHistoryRecord).toHaveBeenCalledOnce());
    expect(onHistoryRecord.mock.calls[0][0]).toMatchObject({ status: 'failed', text: 'tap words' });
    await act(async () => { release.settle(); await rehold; });
    expect(result.current.phase).toBe('recording');
    expect(insert).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenLastCalledWith(SUPERSEDED_DELIVERY_MESSAGE);
    expect(scopes[0].finish).toHaveBeenCalledOnce();
  });

  it('a genuine Escape on the tap still cancels it', async () => {
    const { emitStop, escape, onHistoryRecord, result, transcribe } = await setup({ subscribe: true });
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    expect(escape()).toBe(true);
    emitStop(tapClip, 0);
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
    expect(result.current.phase).toBe('cancelled');
    expect(transcribe).not.toHaveBeenCalled();
    expect(onHistoryRecord).not.toHaveBeenCalled();
  });

  it('a stop the effect sees only after the re-hold took over keeps its own owner', async () => {
    const { capture, insert, onHistoryRecord, rerender, result, scopes } = await setup();
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    await act(async () => { await holdAgain(result); });
    expect(result.current.phase).toBe('recording');
    const owner = vi.mocked(capture.startFullCaptureSession).mock.calls[0][1];
    rerender({ state: { audio: tapClip, kind: 'stopped', owner } });
    await waitFor(() => expect(onHistoryRecord).toHaveBeenCalledOnce());
    expect(onHistoryRecord.mock.calls[0][0]).toMatchObject({ status: 'failed', text: 'tap words' });
    expect(insert).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('recording');
    expect(scopes[1].finish).not.toHaveBeenCalled();
  });

  it('settling during the scope\'s retirement never finishes it twice', async () => {
    const { capture, emitStop, onHistoryRecord, result, scopes } = await setup({ subscribe: true });
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    const finish = deferred<boolean>();
    scopes[0].finish.mockReturnValueOnce(finish.promise);
    let rehold!: Promise<void>;
    act(() => { rehold = holdAgain(result); });
    expect(scopes[0].finish).toHaveBeenCalledOnce();
    emitStop(tapClip, 0); // its settle runs while the retirement's finish is pending
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
    expect(onHistoryRecord).not.toHaveBeenCalled();
    await act(async () => { finish.settle(true); await rehold; });
    await waitFor(() => expect(onHistoryRecord).toHaveBeenCalledOnce());
    expect(scopes[0].finish).toHaveBeenCalledOnce();
    expect(onHistoryRecord.mock.calls[0][0]).toMatchObject({ status: 'failed', text: 'tap words' });
    expect(capture.cancelActiveCapture).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('recording');
  });

  it('retireScope detaches the scope before awaiting finish', async () => {
    const finish = deferred<boolean>();
    const scope = { dispose: vi.fn(async () => {}), finish: vi.fn(() => finish.promise) };
    const cancellation: Cancellation = { cancelled: false, scope };
    const retired = retireScope(cancellation);
    expect(cancellation.scope).toBeUndefined();
    expect(retireScope(cancellation)).toBeUndefined();
    finish.settle(true);
    await retired;
    expect(scope.finish).toHaveBeenCalledOnce();
    expect(cancellation.cancelled).toBe(false);
  });
});

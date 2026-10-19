/** BUS-91: an older capture's stop with audio during a re-hold or after Escape. */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryRow } from '../../../src/features/history/HistoryRow';
import { SUPERSEDED_DELIVERY_MESSAGE } from '../../../src/services/delivery';
import { deferred, setup, tapAudio } from './dogfoodHarness';

afterEach(() => { vi.restoreAllMocks(); });

describe('superseded quick tap (BUS-91)', () => {
  it('a quick tap\'s stop with audio is kept under its own session; the re-hold stays live', async () => {
    const {
      capture, escape, insert, onHistoryRecord, onToast, rerender, result, scopes,
    } = await setup();
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    const release = deferred<void>();
    vi.mocked(capture.waitForCaptureRelease).mockReturnValueOnce(release.promise);
    let rehold!: Promise<void>;
    act(() => { rehold = result.current.start(); });
    await waitFor(() => expect(capture.waitForCaptureRelease).toHaveBeenCalledTimes(2));
    // The tap's audio lands while the re-hold waits: processed, superseded.
    rerender({ state: tapAudio });
    await waitFor(() => expect(onHistoryRecord).toHaveBeenCalledOnce());
    const record = onHistoryRecord.mock.calls[0][0];
    expect(record).toMatchObject({ status: 'failed', text: 'tap words' });
    expect(insert).not.toHaveBeenCalled();
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(SUPERSEDED_DELIVERY_MESSAGE));
    expect(onToast).not.toHaveBeenCalledWith(expect.stringContaining('superseded'));
    // The History row copies the tap's text back.
    const onCopy = vi.fn();
    const row = render(<HistoryRow canStart currentTime={0} isNative onCopy={onCopy}
      onDelete={vi.fn()} onRetry={vi.fn()} record={record} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy transcript' }));
    expect(onCopy).toHaveBeenCalledExactlyOnceWith('tap words');
    row.unmount();
    await act(async () => { release.settle(); await rehold; });
    expect(result.current.phase).toBe('recording');
    expect(scopes).toHaveLength(2);
    expect(scopes[1].finish).not.toHaveBeenCalled();
    expect(scopes[1].dispose).not.toHaveBeenCalled();
    expect(escape()).toBe(true);
    expect(result.current.phase).toBe('cancelled');
    expect(scopes[1].dispose).toHaveBeenCalled();
  });

  it('a tap whose Escape is still queued natively is discarded at the re-hold', async () => {
    const { capture, onHistoryRecord, rerender, result, scopes, transcribe } = await setup();
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    scopes[0].finish.mockResolvedValueOnce(false); // the latch saw Escape
    const release = deferred<void>();
    vi.mocked(capture.waitForCaptureRelease).mockReturnValueOnce(release.promise);
    let rehold!: Promise<void>;
    act(() => { rehold = result.current.start(); });
    await waitFor(() => expect(capture.waitForCaptureRelease).toHaveBeenCalledTimes(2));
    rerender({ state: tapAudio });
    await act(async () => { release.settle(); await rehold; });
    expect(transcribe).not.toHaveBeenCalled();
    expect(onHistoryRecord).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('recording');
  });

  it('tap, Escape, then the tap\'s stop with audio: stays cancelled', async () => {
    const { escape, onHistoryRecord, rerender, result, transcribe } = await setup();
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    expect(escape()).toBe(true);
    rerender({ state: tapAudio });
    expect(result.current.phase).toBe('cancelled');
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
    expect(result.current.phase).toBe('cancelled');
    expect(result.current.message).toBe('Capture cancelled — nothing transcribed.');
    expect(transcribe).not.toHaveBeenCalled();
    expect(onHistoryRecord).not.toHaveBeenCalled();
  });


  it('a cancel during transcription shows no replaced toast', async () => {
    const { escape, onHistoryRecord, onToast, rerender, result, transcribe } = await setup();
    const stt = deferred<{ language: string; text: string }>();
    transcribe.mockReturnValueOnce(stt.promise);
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    rerender({ state: tapAudio });
    await waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
    expect(escape()).toBe(true);
    await act(async () => { stt.settle({ language: 'en', text: 'tap words' }); });
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
    expect(result.current.phase).toBe('cancelled');
    expect(onToast).not.toHaveBeenCalledWith(SUPERSEDED_DELIVERY_MESSAGE);
    expect(onHistoryRecord).not.toHaveBeenCalled();
  });
});

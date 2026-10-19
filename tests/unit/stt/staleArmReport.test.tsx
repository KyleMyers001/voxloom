/** Codex 4318632423: an older start's late arm failure keeps the newer note. */
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CancelUnavailableNote } from '../../../src/features/home/CancelUnavailableNote';
import * as cancelScopeModule from '../../../src/services/shortcut/cancelScope';
import { setup } from './dogfoodHarness';

afterEach(() => { vi.restoreAllMocks(); });

it('keeps the newer ax-untrusted note and its Settings button', async () => {
  const { result } = await setup();
  let rejectOlder!: (error: unknown) => void;
  vi.mocked(cancelScopeModule.beginCancelScope)
    .mockImplementationOnce(() => new Promise<never>((_, reject) => { rejectOlder = reject; }))
    .mockRejectedValueOnce({ code: 'cancel-ax-untrusted', message: 'not trusted' });
  let older!: Promise<void>;
  act(() => { older = result.current.start(); });
  await waitFor(() => expect(cancelScopeModule.beginCancelScope).toHaveBeenCalledOnce());
  await act(async () => { await result.current.start(); });
  await act(async () => {
    rejectOlder({ code: 'cancel-tap-create-failed', message: 'stale' });
    await older;
  });
  const notice = result.current.cancelUnavailable;
  expect(notice?.code).toBe('cancel-ax-untrusted');
  render(<CancelUnavailableNote notice={notice!} onCopy={() => {}} />);
  expect(screen.getByRole('button', { name: /Open System Settings/ })).toBeTruthy();
});

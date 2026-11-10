import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { AppProvider } from '../../src/app/AppContext';
import { Onboarding } from '../../src/features/onboarding/Onboarding';
import { dispatchPracticeGesture } from '../../src/features/onboarding/practiceBridge';
import type { CaptureState } from '../../src/services/capture/types';

const fake = vi.hoisted(() => ({ state: { kind: 'idle' } as CaptureState, start: vi.fn(async () => 'started'), stop: vi.fn(), cancel: vi.fn(), transcribe: vi.fn(async () => ({ text: 'Speech boundary fixture.' })) }));
vi.mock('../../src/services/capture/useCaptureState', () => ({ useCaptureState: () => ({ captureState: fake.state, startFullCaptureSession: fake.start, stopFullCapture: fake.stop, cancelActiveCapture: fake.cancel }) }));
vi.mock('../../src/services/stt/factory', () => ({
  createSttModelStore: () => ({ status: async () => ({ id: 'whisper-base.en', status: 'available' }), list: async () => [], download: vi.fn(), cancel: vi.fn() }),
  createSttEngine: (modelId: string) => ({ modelId, transcribe: fake.transcribe }),
}));

it('joins real capture/STT/delivery hooks for hold then hands-free, preserves hold on Escape and completes only both field results', async () => {
  const io = {
    native: true, query: async () => ({ microphone: 'authorized', accessibility: 'authorized', inputMonitoring: 'authorized' } as const),
    request: vi.fn(), openSettings: vi.fn(), readiness: async (modelId: string) => ({ modelId, ready: true, reason: null }),
    download: vi.fn(), cancelDownload: vi.fn(), activeShortcut: () => 'Ctrl + Shift + Space',
  };
  const progressStorage = { read: () => JSON.stringify({ version: 1, step: 3 }), write: vi.fn() };
  const close = vi.fn();
  const ui = () => <AppProvider><Onboarding boundary={io} onClose={close} progressStorage={progressStorage} /></AppProvider>;
  const { rerender } = render(ui());
  const user = userEvent.setup();
  const field = screen.getByRole('textbox', { name: 'Practice dictation field' });
  field.focus();
  await act(async () => { dispatchPracticeGesture('hold-start'); });
  await waitFor(() => expect(fake.start).toHaveBeenCalledTimes(1));
  act(() => dispatchPracticeGesture('hold-finish'));
  fake.state = { kind: 'stopped', audio: { id: 'hold-audio', duration_ms: 1300, sample_rate_hz: 16000 } };
  rerender(ui());
  await waitFor(() => expect(screen.getByRole('button', { name: /Try double-tap/ })).toBeEnabled());
  expect(field).toHaveValue('Speech boundary fixture.');
  await user.click(screen.getByRole('button', { name: /Try double-tap/ }));
  expect(screen.getByRole('heading', { name: /Now, go hands-free/ })).toBeInTheDocument();
  expect(screen.getByText('✓ Hold to talk')).toBeInTheDocument();
  await act(async () => { dispatchPracticeGesture('latch-start'); });
  await waitFor(() => expect(fake.start).toHaveBeenCalledTimes(2));
  await user.keyboard('{Escape}');
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByText('✓ Hold to talk')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Finish setup/ })).toBeDisabled();
  field.focus();
  await act(async () => { dispatchPracticeGesture('latch-start'); });
  await waitFor(() => expect(fake.start).toHaveBeenCalledTimes(3));
  act(() => dispatchPracticeGesture('latch-finish'));
  fake.state = { kind: 'stopped', audio: { id: 'handsfree-audio', duration_ms: 1300, sample_rate_hz: 16000 } };
  rerender(ui());
  await waitFor(() => expect(screen.getByRole('button', { name: /Finish setup/ })).toBeEnabled());
  expect(field).toHaveValue('Speech boundary fixture.Speech boundary fixture.');
  await user.click(screen.getByRole('button', { name: /Finish setup/ }));
  expect(screen.getByText(/These tries confirm the practice field, not every app/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Open Voxloom' }));
  expect(close).toHaveBeenCalledOnce();
});

it('moving on after a successful try neither cancels capture nor reports a cancelled one', async () => {
  fake.state = { kind: 'idle' };
  fake.start.mockClear();
  fake.cancel.mockClear();
  const io = {
    native: true, query: async () => ({ microphone: 'authorized', accessibility: 'authorized', inputMonitoring: 'authorized' } as const),
    request: vi.fn(), openSettings: vi.fn(), readiness: async (modelId: string) => ({ modelId, ready: true, reason: null }),
    download: vi.fn(), cancelDownload: vi.fn(), activeShortcut: () => 'Ctrl + Shift + Space',
  };
  const progressStorage = { read: () => JSON.stringify({ version: 1, step: 3 }), write: vi.fn() };
  const ui = () => <AppProvider><Onboarding boundary={io} onClose={vi.fn()} progressStorage={progressStorage} /></AppProvider>;
  const { rerender } = render(ui());
  const user = userEvent.setup();
  screen.getByRole('textbox', { name: 'Practice dictation field' }).focus();
  await act(async () => { dispatchPracticeGesture('hold-start'); });
  await waitFor(() => expect(fake.start).toHaveBeenCalledTimes(1));
  act(() => dispatchPracticeGesture('hold-finish'));
  fake.state = { kind: 'stopped', audio: { id: 'moving-on-audio', duration_ms: 1300, sample_rate_hz: 16000 } };
  rerender(ui());
  await waitFor(() => expect(screen.getByRole('button', { name: /Try double-tap/ })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: /Try double-tap/ }));
  expect(screen.getByRole('heading', { name: /Now, go hands-free/ })).toBeInTheDocument();
  expect(screen.queryByText(/Capture cancelled/)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(fake.cancel).not.toHaveBeenCalled();
});

/// Guided practice must never adopt or consume a product recording that was
/// already running when Resume setup opened. Native capture is a single global
/// session and transcription consumes its stopped PCM, so a second consumer
/// would steal Home's utterance and deliver it outside the practice guard.
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { AppProvider } from '../../src/app/AppContext';
import { Onboarding } from '../../src/features/onboarding/Onboarding';
import type { CaptureEvent, CaptureStatus } from '../../src/services/capture/types';
import { createStubDeliveryAdapter } from '../../src/services/delivery';
import { useDogfoodCapture, type UseDogfoodCaptureResult } from '../../src/services/stt/useDogfoodCapture';
import type { SetupBoundary } from '../../src/features/onboarding/guidedSetup';

const native = vi.hoisted(() => {
  const listeners = new Set<(event: CaptureEvent) => void>();
  let next = 0;
  const bus = { active: null as CaptureStatus | null, listeners };
  return {
    bus,
    transcribe: vi.fn(async () => ({ text: 'Product words.' })),
    service: {
      cancelCapture: vi.fn(async () => true),
      createCaptureRequestId: vi.fn(() => `request-${++next}`),
      getCaptureStatus: vi.fn(async () => bus.active),
      isTauriEnv: vi.fn(() => true),
      listDevices: vi.fn(async () => []),
      onCaptureEvent: vi.fn(async (fn: (event: CaptureEvent) => void) => {
        listeners.add(fn);
        return () => { listeners.delete(fn); };
      }),
      queryPermission: vi.fn(async () => undefined),
      requestPermission: vi.fn(async () => undefined),
      startFullCapture: vi.fn(async (requestId: string) => {
        bus.active = { generation: 1, mode: 'full', request_id: requestId };
        return bus.active;
      }),
      startMicTest: vi.fn(),
      stopCapture: vi.fn(async () => undefined),
    },
  };
});
vi.unmock('../../src/services/capture/useCaptureState');
vi.mock('../../src/services/capture/captureService', () => native.service);
vi.mock('../../src/services/stt/factory', () => ({
  createSttModelStore: () => ({ status: async (id: string) => ({ id, status: 'available' }), list: async () => [], download: vi.fn(), cancel: vi.fn() }),
  createSttEngine: (modelId: string) => ({ modelId, transcribe: native.transcribe }),
}));

it('Resume setup during a product recording leaves Home the only transcription consumer', async () => {
  const history = vi.fn();
  const copy = vi.fn(async () => undefined);
  const product: { current: UseDogfoodCaptureResult | null } = { current: null };
  const io: SetupBoundary = {
    native: true, query: async () => ({ microphone: 'authorized', accessibility: 'authorized' }),
    readiness: async (modelId) => ({ modelId, ready: true, reason: null }),
    request: vi.fn(), openSettings: vi.fn(), download: vi.fn(), cancelDownload: vi.fn(), activeShortcut: () => 'Ctrl + Shift + Space',
  };
  function Product() {
    const dogfood = useDogfoodCapture({
      clipboard: { copy }, modelId: 'whisper-base.en', onHistoryRecord: history,
      deliveryPlatform: createStubDeliveryAdapter({ clipboard: { copy } }),
    });
    product.current = dogfood;
    return <output data-testid="product-phase">{dogfood.phase}</output>;
  }
  function Harness({ setupOpen }: { setupOpen: boolean }) {
    return <><Product />{setupOpen && <Onboarding boundary={io} onClose={vi.fn()} progressStorage={{ read: () => JSON.stringify({ version: 1, step: 3 }), write: vi.fn() }} />}</>;
  }
  const { rerender } = render(<AppProvider><Harness setupOpen={false} /></AppProvider>);
  await waitFor(() => expect(native.bus.listeners.size).toBe(1));
  await act(async () => { await product.current!.start('home'); });
  expect(screen.getByTestId('product-phase')).toHaveTextContent('recording');
  const productRequest = native.bus.active!.request_id;

  // Home recording is still running when the user opens Resume setup.
  rerender(<AppProvider><Harness setupOpen /></AppProvider>);
  await waitFor(() => expect(native.bus.listeners.size).toBe(2));
  await waitFor(() => expect(native.service.getCaptureStatus).toHaveBeenCalledTimes(2));
  await act(async () => {});
  const note = screen.getByRole('textbox', { name: 'Practice dictation field' });
  expect(note).toHaveValue('');
  // A practice retry or Close must not cancel the product's native request.
  await userEvent.setup().click(screen.getByRole('button', { name: /Try again|Cancel dictation/ }));
  expect(native.service.cancelCapture).not.toHaveBeenCalledWith(productRequest);
  // Product delivery would otherwise use BUS-201 own-field insertion here.
  act(() => note.blur());

  await act(async () => {
    native.bus.listeners.forEach((fn) => fn({ kind: 'capture-stopped', request_id: productRequest, generation: 1, audio: { id: 'product-pcm', duration_ms: 1200, sample_rate_hz: 16_000 } }));
  });
  await waitFor(() => expect(history).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByTestId('product-phase')).toHaveTextContent('success'));
  expect(native.transcribe).toHaveBeenCalledOnce();
  expect(history.mock.calls[0][0]).toMatchObject({ text: 'Product words.' });
  expect(copy).toHaveBeenCalledWith('Product words.');
  expect(note).toHaveValue('');
  expect(screen.getByRole('button', { name: /Try double-tap/ })).toBeDisabled();
  expect(screen.queryByText('Turning speech into text…')).not.toBeInTheDocument();

  rerender(<AppProvider><Harness setupOpen={false} /></AppProvider>);
  expect(native.service.cancelCapture).not.toHaveBeenCalledWith(productRequest);
});

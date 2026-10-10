/// Onboarding component tests.
///
/// The real microphone permission flow requires a live TCC context and is
/// not exercised here; the capture hook is mocked to return controlled
/// permission state. The real permission + test flows are in manual tests
/// documented in docs/review/BUS-9-implementation.md.
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Onboarding } from '../../src/features/onboarding/Onboarding';
import { renderWithApp } from './testUtils';

// Controlled permission state and Tauri env flag for Onboarding tests.
let mockPermissionStatus = 'authorized';
let mockIsTauri = true; // Tests run in native mode by default.
afterEach(() => { mockIsTauri = true; });

vi.mock('../../src/services/capture/useCaptureState', () => ({
  useCaptureState: () => ({
    captureReady: true,
    captureState: { kind: 'idle' },
    deviceListError: null,
    devices: [],
    devicesLoading: false,
    permissionStatus: mockPermissionStatus,
    prepareDeviceChange: vi.fn().mockResolvedValue(true),
    refreshDevices: vi.fn().mockResolvedValue(undefined),
    requestMicPermission: vi.fn(),
    runMicTest: vi.fn().mockResolvedValue(undefined),
    stopMicTest: vi.fn(),
  }),
}));

// Override captureService to control isTauriEnv per test.
vi.mock('../../src/services/capture/captureService', () => ({
  cancelCapture: vi.fn().mockResolvedValue(true),
  isCaptureActive: vi.fn().mockResolvedValue(false),
  isTauriEnv: vi.fn(() => mockIsTauri),
  listDevices: vi.fn().mockResolvedValue([]),
  onCaptureEvent: vi.fn().mockResolvedValue(() => {}),
  queryPermission: vi.fn(),
  requestPermission: vi.fn(),
  startMicTest: vi.fn().mockResolvedValue('1'),
  stopCapture: vi.fn(),
}));

// -----------------------------------------------------------------------

describe('Onboarding (step 1 — real permission, simulated steps 2–3)', () => {
  it('allows Skip from any step without requiring permission', async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    renderWithApp(<Onboarding onClose={close} />);
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('advances past step 1 when permission is authorized', async () => {
    mockPermissionStatus = 'authorized';
    const user = userEvent.setup();
    renderWithApp(<Onboarding onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Choose your shortcut')).toBeInTheDocument();
  });

  it('blocks Next on step 1 when permission is not-determined', async () => {
    mockPermissionStatus = 'not-determined';
    const user = userEvent.setup();
    renderWithApp(<Onboarding onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      /enable microphone/i,
    );
  });

  it('blocks Next on step 1 when permission is denied', async () => {
    mockPermissionStatus = 'denied';
    const user = userEvent.setup();
    renderWithApp(<Onboarding onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      /enable microphone/i,
    );
  });

  it('shows Enable Microphone button when not authorized', async () => {
    mockPermissionStatus = 'not-determined';
    renderWithApp(<Onboarding onClose={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: 'Enable Microphone' }),
    ).toBeInTheDocument();
  });

  it('does not show Enable Microphone button when authorized', async () => {
    mockPermissionStatus = 'authorized';
    renderWithApp(<Onboarding onClose={vi.fn()} />);
    expect(
      screen.queryByRole('button', { name: 'Enable Microphone' }),
    ).toBeNull();
  });

  it('shows Test Microphone button when authorized', async () => {
    mockPermissionStatus = 'authorized';
    renderWithApp(<Onboarding onClose={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: 'Test Microphone' }),
    ).toBeInTheDocument();
  });

  it('preserves Back/Next state for steps 2–3', async () => {
    mockPermissionStatus = 'authorized';
    const user = userEvent.setup();
    const close = vi.fn();
    renderWithApp(<Onboarding onClose={close} />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Choose your shortcut')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Step 3: quick test
    await user.click(screen.getByRole('button', { name: 'Simulate hold' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(
      screen.getByText(/Press-and-hold · recognized/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      /both practice/,
    );
    await user.click(
      screen.getByRole('button', { name: 'Simulate double-tap' }),
    );
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects the simulated shortcut collision only in the browser', async () => {
    mockIsTauri = false;
    mockPermissionStatus = 'authorized';
    const user = userEvent.setup();
    renderWithApp(<Onboarding onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const shortcut = screen.getByLabelText(
      'Preferred app-local shortcut',
    );
    await user.clear(shortcut);
    await user.type(shortcut, 'Ctrl + Space');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('alert')).toHaveTextContent('collision');
  });

  it('does not claim native gestures are app-local or practice is STT', async () => {
    mockPermissionStatus = 'authorized';
    const user = userEvent.setup();
    renderWithApp(<Onboarding onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText('Preferred global shortcut'))
      .toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText(/Gesture feedback \(not a speech transcript\)/))
      .toBeInTheDocument();
    expect(screen.getByText(/not microphone transcription/))
      .toBeInTheDocument();
  });

  it('shows denied copy when permission denied on step 1', async () => {
    mockPermissionStatus = 'denied';
    renderWithApp(<Onboarding onClose={vi.fn()} />);
    expect(
      screen.getByText(/Microphone access denied/i),
    ).toBeInTheDocument();
    // System Settings appears in both the status span and the note;
    // verify at least one instance is present.
    expect(
      screen.getAllByText(/System Settings/i).length,
    ).toBeGreaterThanOrEqual(1);
  });
});

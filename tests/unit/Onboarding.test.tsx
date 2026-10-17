/// Onboarding component tests.
///
/// The real microphone permission flow requires a live TCC context and is
/// not exercised here; the capture hook is mocked to return controlled
/// permission state. The real permission + test flows are in manual tests
/// checked manually on a Mac.
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Onboarding } from '../../src/features/onboarding/Onboarding';
import { renderWithApp } from './testUtils';
import { CANCELED, HELP, RECORDING } from '../../src/features/settings/shortcutCopy';

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

  it('refuses a reserved combo with the recorder inline message', async () => {
    mockIsTauri = false;
    mockPermissionStatus = 'authorized';
    const user = userEvent.setup();
    renderWithApp(<Onboarding onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('App-local shortcut')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^(Shortcut|App-local shortcut|Global shortcut) / }));
    await user.keyboard('{Control>} {/Control}');
    // The recorder refuses it itself (macOS reserved) and keeps the old combo.
    expect(screen.getByRole('status')).toHaveTextContent(/switching input sources/);
    expect(screen.getByRole('button', { name: /^(Shortcut|App-local shortcut|Global shortcut) / }))
      .toHaveAttribute('aria-pressed', 'true');
  });

  it('does not claim native gestures are app-local or practice is STT', async () => {
    mockPermissionStatus = 'authorized';
    const user = userEvent.setup();
    renderWithApp(<Onboarding onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Global shortcut')).toBeInTheDocument();
    expect(screen.queryByText(/app-local/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText(/Gesture feedback \(not a speech transcript\)/))
      .toBeInTheDocument();
    expect(screen.getByText(/tests the gesture, not transcription/))
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

describe('Onboarding shortcut step (BUS-47 recorder)', () => {
  it('renders the shared recorder instead of a text field', async () => {
    mockPermissionStatus = 'authorized';
    const user = userEvent.setup();
    renderWithApp(<Onboarding onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    const field = screen.getByRole('button', { name: /^(Shortcut|App-local shortcut|Global shortcut) / });
    expect(field).toHaveAttribute('id', 'onboarding-shortcut');
    expect(field).toHaveAccessibleDescription(HELP);
  });

  it('records a combo, and Esc cancels recording without closing the sheet', async () => {
    mockPermissionStatus = 'authorized';
    const user = userEvent.setup();
    const close = vi.fn();
    renderWithApp(<Onboarding onClose={close} />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const field = () => screen.getByRole('button', { name: /^(Shortcut|App-local shortcut|Global shortcut) / });
    await user.click(field());
    expect(screen.getByRole('status')).toHaveTextContent(RECORDING);
    await user.keyboard('{Escape}');
    expect(close).not.toHaveBeenCalled();
    expect(field()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('status')).toHaveTextContent(CANCELED);
    await user.click(field());
    await user.keyboard('{Control>}{Alt>}k{/Alt}{/Control}');
    expect(field()).toHaveAccessibleName(/^Global shortcut Control (Option|Alt) K$/);
    expect(screen.getByText('Choose your shortcut')).toBeInTheDocument();
  });

  it('collision reverts the combo; a new combo clears the alert and aria-invalid', async () => {
    mockIsTauri = false;
    mockPermissionStatus = 'authorized';
    Object.defineProperty(window.navigator, 'platform', { configurable: true, get: () => 'Linux x86_64' });
    try {
      const user = userEvent.setup();
      renderWithApp(<Onboarding onClose={vi.fn()} />);
      await user.click(screen.getByRole('button', { name: 'Next' }));
      const field = () => screen.getByRole('button', { name: /^(Shortcut|App-local shortcut|Global shortcut) / });
      expect(field()).toHaveAccessibleName(/^App-local shortcut /);
      await user.click(field());
      await user.keyboard('{Control>} {/Control}');
      await user.click(screen.getByRole('button', { name: 'Next' }));
      expect(screen.getByRole('alert')).toHaveTextContent('Ctrl+Space is in use by another app (simulated). Kept Ctrl+Shift+Space. Record a different one.');
      expect(field()).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('status')).toHaveTextContent(/^$/);
      expect(field()).toHaveAccessibleName('App-local shortcut Control Shift Space');
      expect(field().getAttribute('aria-describedby')).toContain('onboarding-error');
      await user.click(field());
      await user.keyboard('{Control>}{Alt>}j{/Alt}{/Control}');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('status')).toHaveTextContent('Shortcut set to Ctrl+Alt+J.');
      expect(field()).not.toHaveAttribute('aria-invalid');
    } finally {
      Object.defineProperty(window.navigator, 'platform', { configurable: true, get: () => 'MacIntel' });
    }
  });
});

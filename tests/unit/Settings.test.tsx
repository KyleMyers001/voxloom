/// Settings component tests.
///
/// The capture hook is mocked to avoid live IPC. Real permission flow,
/// real device list, and real mic test are covered in manual tests
/// documented in docs/review/BUS-9-implementation.md.
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '../../src/features/settings/Settings';
import { renderWithApp } from './testUtils';

// --- Capture hook mock -------------------------------------------------
const captureMocks = vi.hoisted(() => ({
  captureReady: true,
  devices: [
    { available: true, id: 'input-1', label: 'Built-in Microphone' },
    { available: true, id: 'input-2', label: 'USB Audio' },
  ],
  prepareDeviceChange: vi.fn().mockResolvedValue(true),
  refreshDevices: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/capture/useCaptureState', () => ({
  useCaptureState: () => ({
    captureReady: captureMocks.captureReady,
    captureState: { kind: 'idle' },
    deviceListError: null,
    devices: captureMocks.devices,
    devicesLoading: false,
    permissionStatus: 'authorized',
    prepareDeviceChange: captureMocks.prepareDeviceChange,
    refreshDevices: captureMocks.refreshDevices,
    requestMicPermission: vi.fn(),
    runMicTest: vi.fn().mockResolvedValue(undefined),
    stopMicTest: vi.fn(),
  }),
}));

vi.mock('../../src/services/capture/captureService', () => ({
  isTauriEnv: vi.fn().mockReturnValue(true),
}));
// -----------------------------------------------------------------------

describe('Settings', () => {
  beforeEach(() => {
    captureMocks.captureReady = true;
    captureMocks.devices = [
      { available: true, id: 'input-1', label: 'Built-in Microphone' },
      { available: true, id: 'input-2', label: 'USB Audio' },
    ];
    captureMocks.prepareDeviceChange.mockReset();
    captureMocks.prepareDeviceChange.mockResolvedValue(true);
    captureMocks.refreshDevices.mockClear();
  });

  it('updates style and appearance controls', async () => {
    const user = userEvent.setup();
    renderWithApp(<Settings onSetup={vi.fn()} />);
    const style = screen.getByRole('radiogroup', { name: /Style preference/ });
    await user.click(within(style).getByRole('radio', { name: 'Casual' }));
    expect(within(style).getByRole('radio', { name: 'Casual' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('tab', { name: 'Appearance' }));
    await user.click(screen.getByLabelText('Dark'));
    expect(screen.getByLabelText('Dark')).toBeChecked();
    expect(screen.queryByLabelText('Sodium Rain')).toBeNull();
    expect(within(screen.getByRole('group', { name: 'Theme' })).getAllByRole('radio')).toHaveLength(3);
  });

  it('calls onSetup when Set up shortcuts clicked', async () => {
    const user = userEvent.setup();
    const setup = vi.fn();
    renderWithApp(<Settings onSetup={setup} />);
    await user.click(
      screen.getByRole('button', { name: 'Set up shortcuts' }),
    );
    expect(setup).toHaveBeenCalledOnce();
  });

  it('labels remaining mock settings without calling shortcut simulated', async () => {
    renderWithApp(<Settings onSetup={vi.fn()} />);
    expect(screen.getByLabelText('Shortcut')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Start at login/ })).toBeDisabled();
    // S8: hidden in the native app (CHECKLIST § Hidden in the native app).
    expect(screen.queryByLabelText(/Language-processing model/)).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Privacy' }));
    expect(screen.getByText(/register-or-revert/i)).toBeInTheDocument();
  });

  it('does not let native users select unsupported cleanup, login or audio retention', () => {
    renderWithApp(<Settings onSetup={vi.fn()} />);
    expect(screen.queryByLabelText(/Language-processing model/)).toBeNull();
    expect(screen.getByRole('switch', { name: /Start at login/ })).toBeDisabled();
    expect(screen.queryByRole('option', { name: 'English (UK)' })).toBeNull();
    cleanup();
    renderWithApp(<Settings initialTab="privacy" onSetup={vi.fn()} />);
    expect(screen.getByLabelText(/Audio retention/)).toBeDisabled();
    expect(screen.queryByText(/Temporary recovery buffers expire/))
      .not.toBeInTheDocument();
  });

  it('does not claim audio resets on reload', () => {
    renderWithApp(<Settings initialTab="privacy" onSetup={vi.fn()} />);
    // The old false copy "resets on reload" is gone; verify replacement.
    expect(screen.queryByText(/resets on reload/i)).toBeNull();
    expect(screen.getByText(/captured locally/i)).toBeInTheDocument();
  });

  it('renders real device names in the microphone select', () => {
    renderWithApp(<Settings onSetup={vi.fn()} />);
    expect(
      screen.getByRole('option', { name: 'Built-in Microphone' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'USB Audio' }),
    ).toBeInTheDocument();
  });

  it('locks device controls until native ownership is known', () => {
    captureMocks.captureReady = false;
    renderWithApp(<Settings onSetup={vi.fn()} />);

    expect(screen.getByLabelText(/Microphone/)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh microphones' }))
      .toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test Microphone' }))
      .toBeDisabled();
  });

  it('waits for teardown before committing a device change', async () => {
    const user = userEvent.setup();
    captureMocks.prepareDeviceChange.mockReturnValueOnce(
      new Promise<boolean>(() => {}),
    );
    renderWithApp(<Settings onSetup={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText(/Microphone/), 'input-2');
    expect(captureMocks.prepareDeviceChange).toHaveBeenCalledOnce();
    expect(screen.getByLabelText(/Microphone/)).toHaveValue(
      'system-default',
    );
  });

  it('does not commit a device change when teardown fails', async () => {
    const user = userEvent.setup();
    captureMocks.prepareDeviceChange.mockResolvedValueOnce(false);
    renderWithApp(<Settings onSetup={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText(/Microphone/), 'input-2');
    expect(screen.getByLabelText(/Microphone/)).toHaveValue(
      'system-default',
    );
  });

  it('retains a missing selected device as unavailable', async () => {
    const user = userEvent.setup();
    renderWithApp(<Settings onSetup={vi.fn()} />);
    await user.selectOptions(screen.getByLabelText(/Microphone/), 'input-2');
    expect(screen.getByLabelText(/Microphone/)).toHaveValue('input-2');

    captureMocks.devices = [
      { available: true, id: 'input-1', label: 'Built-in Microphone' },
    ];
    await user.click(screen.getByRole('radio', { name: 'Casual' }));

    expect(screen.getByLabelText(/Microphone/)).toHaveValue('input-2');
    expect(screen.getByRole('option', {
      name: 'USB Audio (unavailable)',
    })).toBeDisabled();
    expect(screen.getByRole('button', {
      name: 'Test Microphone',
    })).toBeDisabled();
  });

  it('shows Test Microphone button when authorized', () => {
    renderWithApp(<Settings onSetup={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: 'Test Microphone' }),
    ).toBeInTheDocument();
  });

  it('shows honest recovery copy for microphone denied', () => {
    renderWithApp(<Settings initialTab="privacy" onSetup={vi.fn()} />);
    expect(
      screen.getByText(/Microphone denied/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Privacy.*Security.*Microphone/i),
    ).toBeInTheDocument();
  });

  it('lists STT models without starting a download on open', async () => {
    renderWithApp(<Settings initialTab="models" onSetup={vi.fn()} />);
    expect(
      await screen.findByRole('heading', { name: 'Speech-to-text models' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('whisper-tiny.en'),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: 'Download' }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByRole('button', { name: 'Cancel download' }),
    ).toBeNull();
  });

  it('selects a modelId into settings without downloading', async () => {
    const user = userEvent.setup();
    renderWithApp(<Settings initialTab="models" onSetup={vi.fn()} />);
    await screen.findByText('whisper-base.en');
    const baseRadio = screen.getByRole('radio', {
      name: /Whisper Base \(English\)/i,
    });
    await user.click(baseRadio);
    expect(baseRadio).toBeChecked();
    expect(
      screen.getByText(/Selected for transcription/i),
    ).toBeInTheDocument();
  });

  it('downloads a model only after explicit Download click', async () => {
    const user = userEvent.setup();
    renderWithApp(<Settings initialTab="models" onSetup={vi.fn()} />);
    await screen.findByText('whisper-tiny.en');
    const downloads = screen.getAllByRole('button', { name: 'Download' });
    await user.click(downloads[0]);
    expect(await screen.findByText('On disk')).toBeInTheDocument();
    expect(screen.getByText('available')).toBeInTheDocument();
  });
});

describe('Shortcut field (one representation at a time)', () => {
  it('hides the key caps while the raw text is being edited', async () => {
    const user = userEvent.setup();
    const { container } = renderWithApp(<Settings onSetup={vi.fn()} />);
    expect(container.querySelector('.frow__control .key-combo')).not.toBeNull();
    await user.click(screen.getByLabelText('Shortcut'));
    expect(container.querySelector('.frow__control .key-combo')).toBeNull();
    await user.tab();
    expect(container.querySelector('.frow__control .key-combo')).not.toBeNull();
  });
});

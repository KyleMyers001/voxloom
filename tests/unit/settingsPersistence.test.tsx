import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { AppProvider } from '../../src/app/AppContext';
import { initialSettings } from '../../src/domain/fixtures';
import {
  createMemorySettingsIo,
  createSettingsStore,
  serializeSettingsFile,
} from '../../src/services/settings';
import {
  createHistoryStore,
  createMemoryHistoryIo,
} from '../../src/services/history';

describe('durable settings persistence', () => {
  it('hydrates retention from settings.json on boot', async () => {
    const settingsIo = createMemorySettingsIo(
      serializeSettingsFile(
        { ...initialSettings, transcriptRetention: 'forever' },
        true,
      ),
    );
    const user = userEvent.setup();
    render(
      <AppProvider
        clock={() => 1_800_000_000_000}
        historyPersistence={{
          enabled: true,
          store: createHistoryStore(createMemoryHistoryIo(null)),
        }}
        settingsPersistence={{
          enabled: true,
          store: createSettingsStore(settingsIo),
        }}
      >
        <App />
      </AppProvider>,
    );

    // onboardingComplete=true → overlay should close without Skip.
    await waitFor(() => {
      expect(screen.queryByText('Step 1 of 3')).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const retention = await screen.findByLabelText(/Transcript retention/i);
    expect(retention).toHaveValue('forever');
  });

  it('persists retention changes and rolls back on save failure', async () => {
    const settingsIo = createMemorySettingsIo(
      serializeSettingsFile(initialSettings, true),
    );
    const store = createSettingsStore(settingsIo);
    const user = userEvent.setup();
    render(
      <AppProvider
        clock={() => 1_800_000_000_000}
        settingsPersistence={{ enabled: true, store }}
      >
        <App />
      </AppProvider>,
    );

    await waitFor(() => {
      expect(screen.queryByText('Step 1 of 3')).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Settings' }));

    const retention = await screen.findByLabelText(/Transcript retention/i);
    await user.selectOptions(retention, 'off');
    await waitFor(() => {
      expect(settingsIo.snapshot()).toContain('"transcriptRetention": "off"');
    });

    const saveSpy = vi.spyOn(store, 'save').mockRejectedValueOnce(
      new Error('disk full'),
    );
    await user.selectOptions(retention, 'forever');
    await waitFor(() => {
      expect(screen.getByText(/Failed to save settings/i)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(retention).toHaveValue('off');
    });
    saveSpy.mockRestore();
  });

  it('uses defaults + toast on corrupt settings without wiping history IO', async () => {
    const historyIo = createMemoryHistoryIo(
      JSON.stringify({
        records: [{
          createdAt: 1_800_000_000_000,
          durationSeconds: 1,
          id: 'keep-me',
          model: null,
          recoveryExpiresAt: null,
          status: 'copied',
          style: 'formal',
          text: 'must survive',
        }],
        version: 1,
      }),
    );
    const settingsIo = createMemorySettingsIo('{corrupt');
    const user = userEvent.setup();
    render(
      <AppProvider
        clock={() => 1_800_000_000_000}
        historyPersistence={{
          enabled: true,
          store: createHistoryStore(historyIo),
        }}
        settingsPersistence={{
          enabled: true,
          store: createSettingsStore(settingsIo),
        }}
      >
        <App />
      </AppProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/not valid JSON|Settings file/i))
        .toBeInTheDocument();
    });
    // BUS-42: corrupt bytes are backed up, then replaced with v1 defaults.
    expect(settingsIo.backups()).toEqual(['{corrupt']);
    expect(JSON.parse(settingsIo.snapshot()!)).toMatchObject({ version: 1 });
    // History file still holds its original payload.
    expect(historyIo.snapshot()).toContain('keep-me');

    await user.click(screen.getByRole('button', { name: 'Skip' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const retention = await screen.findByLabelText(/Transcript retention/i);
    expect(retention).toHaveValue('30-days');
  });
});

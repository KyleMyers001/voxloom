import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/app/App';
import { AppProvider } from '../../src/app/AppContext';
import { initialSettings } from '../../src/domain/fixtures';
import {
  createDictionaryStore,
  createMemoryDictionaryIo,
  serializeDictionaryFile,
  type DurableDictionaryStore,
} from '../../src/services/dictionary';
import {
  createHistoryStore,
  createMemoryHistoryIo,
  serializeHistoryFile,
  type HistoryStore,
} from '../../src/services/history';
import {
  createMemorySettingsIo,
  createSettingsStore,
  serializeSettingsFile,
  type DurableSettingsStore,
} from '../../src/services/settings';

function deferredGate() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release: () => release() };
}

function delaySettingsLoad(
  store: DurableSettingsStore,
  gate: Promise<void>,
): DurableSettingsStore {
  return {
    load: async () => {
      await gate;
      return store.load();
    },
    save: (settings, onboardingComplete) =>
      store.save(settings, onboardingComplete),
  };
}

function delayHistoryLoad(
  store: HistoryStore,
  gate: Promise<void>,
): HistoryStore {
  return {
    load: async (retention, now) => {
      await gate;
      return store.load(retention, now);
    },
    save: (records, retention, now) => store.save(records, retention, now),
  };
}

function delayDictionaryLoad(
  store: DurableDictionaryStore,
  gate: Promise<void>,
): DurableDictionaryStore {
  return {
    load: async () => {
      await gate;
      return store.load();
    },
    save: (words) => store.save(words),
  };
}

describe('boot hydrate polish', () => {
  it('does not flash fixture settings before async hydrate settles', async () => {
    const { gate, release } = deferredGate();
    const settingsStore = delaySettingsLoad(
      createSettingsStore(
        createMemorySettingsIo(
          serializeSettingsFile(
            { ...initialSettings, transcriptRetention: 'forever' },
            true,
          ),
        ),
      ),
      gate,
    );
    const user = userEvent.setup();
    render(
      <AppProvider
        clock={() => 1_800_000_000_000}
        dictionaryPersistence={{
          enabled: true,
          store: createDictionaryStore(createMemoryDictionaryIo(
            serializeDictionaryFile(['PersistedWord']),
          )),
        }}
        historyPersistence={{
          enabled: true,
          store: createHistoryStore(createMemoryHistoryIo(
            serializeHistoryFile([{
              createdAt: 1_800_000_000_000,
              durationSeconds: 1,
              id: 'durable-1',
              model: null,
              recoveryExpiresAt: null,
              status: 'copied',
              style: 'formal',
              text: 'durable history row',
            }]),
          )),
        }}
        settingsPersistence={{ enabled: true, store: settingsStore }}
      >
        <App />
      </AppProvider>,
    );

    // Dismiss fixture onboarding so nav is usable while durable hydrate waits.
    await user.click(screen.getByRole('button', { name: 'Skip' }));

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expect(
      screen.queryByLabelText(/Transcript retention/i),
    ).not.toBeInTheDocument();
    // Fixture default retention must not appear while hydrate is pending.
    expect(screen.queryByDisplayValue('30-days')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dictionary' }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expect(screen.queryByText('JSON')).not.toBeInTheDocument();
    expect(screen.queryByText('PersistedWord')).not.toBeInTheDocument();
    expect(screen.queryByText('No words yet')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'History' }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expect(
      screen.queryByText(/Make retry explicit/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('durable history row'),
    ).not.toBeInTheDocument();

    release();

    await waitFor(() => {
      expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    });
    expect(await screen.findByText('durable history row')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(await screen.findByRole('tab', { name: 'Privacy' }));
    const retention = await screen.findByRole('radiogroup', { name: 'Transcript retention' });
    expect(within(retention).getByRole('radio', { name: 'Until deleted' })).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('button', { name: 'Dictionary' }));
    expect(await screen.findByText('PersistedWord')).toBeInTheDocument();
    expect(screen.queryByText('JSON')).not.toBeInTheDocument();
  });

  it('marks boot ready after fail-safe corrupt load (toast + defaults)', async () => {
    const { gate, release } = deferredGate();
    const settingsStore = delaySettingsLoad(
      createSettingsStore(createMemorySettingsIo('{corrupt')),
      gate,
    );
    const historyStore = delayHistoryLoad(
      createHistoryStore(createMemoryHistoryIo(null)),
      gate,
    );
    const dictionaryStore = delayDictionaryLoad(
      createDictionaryStore(createMemoryDictionaryIo('{corrupt')),
      gate,
    );
    const user = userEvent.setup();
    render(
      <AppProvider
        clock={() => 1_800_000_000_000}
        dictionaryPersistence={{ enabled: true, store: dictionaryStore }}
        historyPersistence={{ enabled: true, store: historyStore }}
        settingsPersistence={{ enabled: true, store: settingsStore }}
      >
        <App />
      </AppProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Skip' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');

    release();

    await waitFor(() => {
      expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText(/not valid JSON|Settings file|Dictionary file/i))
        .toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(await screen.findByRole('tab', { name: 'Privacy' }));
    const retention = await screen.findByRole('radiogroup', { name: 'Transcript retention' });
    expect(within(retention).getByRole('radio', { name: '30 days' })).toHaveAttribute('aria-checked', 'true');
  });

  it('is boot-ready immediately when durable persistence is off', async () => {
    const user = userEvent.setup();
    render(
      <AppProvider clock={() => 1_800_000_000_000}>
        <App />
      </AppProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('tab', { name: 'Privacy' }));
    expect(
      await screen.findByRole('radiogroup', { name: 'Transcript retention' }),
    ).toBeInTheDocument();
  });
});

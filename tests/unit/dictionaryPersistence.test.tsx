import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { AppProvider } from '../../src/app/AppContext';
import { initialSettings } from '../../src/domain/fixtures';
import {
  createDictionaryStore,
  createMemoryDictionaryIo,
  serializeDictionaryFile,
} from '../../src/services/dictionary';
import {
  createHistoryStore,
  createMemoryHistoryIo,
  serializeHistoryFile,
} from '../../src/services/history';
import {
  createMemorySettingsIo,
  createSettingsStore,
  serializeSettingsFile,
} from '../../src/services/settings';

describe('durable dictionary persistence', () => {
  it('hydrates words from dictionary.json on boot', async () => {
    const dictionaryIo = createMemoryDictionaryIo(
      serializeDictionaryFile(['PersistedWord']),
    );
    const user = userEvent.setup();
    render(
      <AppProvider
        clock={() => 1_800_000_000_000}
        dictionaryPersistence={{
          enabled: true,
          store: createDictionaryStore(dictionaryIo),
        }}
        historyPersistence={{
          enabled: true,
          store: createHistoryStore(createMemoryHistoryIo(null)),
        }}
        settingsPersistence={{
          enabled: true,
          store: createSettingsStore(
            createMemorySettingsIo(serializeSettingsFile(initialSettings, true)),
          ),
        }}
      >
        <App />
      </AppProvider>,
    );

    await waitFor(() => {
      expect(screen.queryByText(/Step 1 of/i)).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Dictionary' }));
    expect(await screen.findByText('PersistedWord')).toBeInTheDocument();
  });

  it('persists add and rolls back delete when save fails', async () => {
    const dictionaryIo = createMemoryDictionaryIo(serializeDictionaryFile([]));
    const store = createDictionaryStore(dictionaryIo);
    const user = userEvent.setup();
    render(
      <AppProvider
        clock={() => 1_800_000_000_000}
        dictionaryPersistence={{ enabled: true, store }}
        settingsPersistence={{
          enabled: true,
          store: createSettingsStore(
            createMemorySettingsIo(serializeSettingsFile(initialSettings, true)),
          ),
        }}
      >
        <App />
      </AppProvider>,
    );

    await waitFor(() => {
      expect(screen.queryByText(/Step 1 of/i)).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Dictionary' }));
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    await user.type(screen.getByLabelText('Word'), 'Durable');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(dictionaryIo.snapshot()).toContain('Durable');
    });

    const saveSpy = vi.spyOn(store, 'save').mockRejectedValueOnce(
      new Error('disk full'),
    );
    await user.click(screen.getByRole('button', { name: 'Delete Durable' }));
    await waitFor(() => {
      expect(screen.getByText(/Failed to save dictionary/i)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText('Durable')).toBeInTheDocument();
    });
    saveSpy.mockRestore();
  });

  it('uses empty + toast on corrupt dictionary without wiping sibling stores', async () => {
    const historyIo = createMemoryHistoryIo(
      serializeHistoryFile([{
        createdAt: 1_800_000_000_000,
        durationSeconds: 1,
        id: 'keep-me',
        model: null,
        recoveryExpiresAt: null,
        status: 'copied',
        style: 'formal',
        text: 'must survive',
      }]),
    );
    const settingsIo = createMemorySettingsIo(
      serializeSettingsFile(initialSettings, true),
    );
    const dictionaryIo = createMemoryDictionaryIo('{corrupt');
    const user = userEvent.setup();
    render(
      <AppProvider
        clock={() => 1_800_000_000_000}
        dictionaryPersistence={{
          enabled: true,
          store: createDictionaryStore(dictionaryIo),
        }}
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
      expect(screen.getByText(/not valid JSON|Dictionary file/i))
        .toBeInTheDocument();
    });
    expect(dictionaryIo.snapshot()).toBe('{corrupt');
    expect(settingsIo.snapshot()).toContain('version');
    expect(historyIo.snapshot()).toContain('keep-me');

    await user.click(screen.getByRole('button', { name: 'Dictionary' }));
    expect(screen.getByText('No words yet')).toBeInTheDocument();
  });
});

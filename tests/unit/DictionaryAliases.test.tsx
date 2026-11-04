import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/app/App';
import { AppProvider } from '../../src/app/AppContext';
import { initialSettings } from '../../src/domain/fixtures';
import { Dictionary } from '../../src/features/dictionary/Dictionary';
import {
  createDictionaryStore,
  createMemoryDictionaryIo,
  serializeDictionaryFile,
} from '../../src/services/dictionary';
import { createHistoryStore, createMemoryHistoryIo } from '../../src/services/history';
import {
  createMemorySettingsIo,
  createSettingsStore,
  serializeSettingsFile,
} from '../../src/services/settings';
import { renderWithApp } from './testUtils';

describe('Also heard as (word dialog)', () => {
  it('has a labelled optional field with a hint, empty for a new word', async () => {
    const user = userEvent.setup();
    renderWithApp(<Dictionary />);
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    const field = screen.getByLabelText('Also heard as (optional)');
    expect(field).toHaveValue('');
    expect(field).toHaveAccessibleDescription('Separate with commas. Example: box loom, vox loom');
  });

  it('saves a word with aliases and shows them in the list', async () => {
    const user = userEvent.setup();
    renderWithApp(<Dictionary />);
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    await user.type(screen.getByLabelText('Word'), 'Voxloom');
    await user.type(screen.getByLabelText('Also heard as (optional)'), ' box loom, voks loom ,');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Also heard as: box loom, voks loom')).toBeInTheDocument();
  });

  it('shows no aliases line for a word without any', async () => {
    renderWithApp(<Dictionary />);
    expect(screen.queryByText(/Also heard as:/)).not.toBeInTheDocument();
  });

  it('opens an existing word with its aliases and lets them be edited or cleared', async () => {
    const user = userEvent.setup();
    renderWithApp(<Dictionary />);
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    await user.type(screen.getByLabelText('Word'), 'Voxloom');
    await user.type(screen.getByLabelText('Also heard as (optional)'), 'box loom');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(screen.getByRole('button', { name: 'Edit Voxloom' }));
    const field = screen.getByLabelText('Also heard as (optional)');
    expect(field).toHaveValue('box loom');
    await user.clear(field);
    await user.type(field, 'voks loom, boxloom');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Also heard as: voks loom, boxloom')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit Voxloom' }));
    await user.clear(screen.getByLabelText('Also heard as (optional)'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByText(/Also heard as:/)).not.toBeInTheDocument();
  });

  it('keeps the aliases when the word is renamed, and removes them with the word', async () => {
    const user = userEvent.setup();
    renderWithApp(<Dictionary />);
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    await user.type(screen.getByLabelText('Word'), 'Voxloom');
    await user.type(screen.getByLabelText('Also heard as (optional)'), 'box loom');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(screen.getByRole('button', { name: 'Edit Voxloom' }));
    await user.clear(screen.getByLabelText('Word'));
    await user.type(screen.getByLabelText('Word'), 'Voxloom2');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Also heard as: box loom')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete Voxloom2' }));
    expect(screen.queryByText(/Also heard as:/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    await user.type(screen.getByLabelText('Word'), 'Other');
    await user.type(screen.getByLabelText('Also heard as (optional)'), 'box loom');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows an inline alias error in the error slot and keeps the dialog open', async () => {
    const user = userEvent.setup();
    renderWithApp(<Dictionary />);
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    await user.type(screen.getByLabelText('Word'), 'Skyloom');
    const field = screen.getByLabelText('Also heard as (optional)');
    await user.type(field, 'sky');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('"sky" is a common word and would change ordinary speech. Use a longer phrase.');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field.getAttribute('aria-describedby')).toContain(alert.id);
    expect(screen.getByLabelText('Word')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, 'sky lume, skylum');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('rejects an alias that is another word or alias, or the word itself', async () => {
    const user = userEvent.setup();
    renderWithApp(<Dictionary />);
    // fixture words: JSON, Postgres, TanStack Query, TypeScript
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    await user.type(screen.getByLabelText('Word'), 'Tauri');
    await user.type(screen.getByLabelText('Also heard as (optional)'), 'type script');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('"type script" is already in your dictionary.');
    await user.clear(screen.getByLabelText('Also heard as (optional)'));
    await user.type(screen.getByLabelText('Also heard as (optional)'), 'tauri');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('"tauri" is the word itself.');
  });

  it('shows the word error and the alias error together', async () => {
    const user = userEvent.setup();
    renderWithApp(<Dictionary />);
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    await user.type(screen.getByLabelText('Word'), 'json');
    await user.type(screen.getByLabelText('Also heard as (optional)'), 'will');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveTextContent('already in your dictionary');
    expect(alerts[1]).toHaveTextContent('"will" is a common word');
  });

  it('refuses a new word that is already another word\'s alias', async () => {
    const user = userEvent.setup();
    renderWithApp(<Dictionary />);
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    await user.type(screen.getByLabelText('Word'), 'Voxloom');
    await user.type(screen.getByLabelText('Also heard as (optional)'), 'box loom');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    await user.type(screen.getByLabelText('Word'), 'Box Loom');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('"Box Loom" is already an alias of Voxloom.');
  });

  it('search finds a word by one of its aliases', async () => {
    const user = userEvent.setup();
    renderWithApp(<Dictionary />);
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    await user.type(screen.getByLabelText('Word'), 'Voxloom');
    await user.type(screen.getByLabelText('Also heard as (optional)'), 'box loom');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.type(screen.getByRole('searchbox'), 'box lo');
    expect(screen.getByText('Voxloom')).toBeInTheDocument();
    expect(screen.queryByText('Postgres')).not.toBeInTheDocument();
  });

  it('tabs from the word to aliases to the buttons', async () => {
    const user = userEvent.setup();
    renderWithApp(<Dictionary />);
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    const dialog = screen.getByRole('dialog');
    expect(screen.getByLabelText('Word')).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByLabelText('Also heard as (optional)')).toHaveFocus();
  });
});

describe('aliases through dictionary.json', () => {
  function renderPersisted(io: ReturnType<typeof createMemoryDictionaryIo>) {
    return render(
      <AppProvider
        clock={() => 1_800_000_000_000}
        dictionaryPersistence={{ enabled: true, store: createDictionaryStore(io) }}
        historyPersistence={{ enabled: true, store: createHistoryStore(createMemoryHistoryIo(null)) }}
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
  }

  it('loads aliases on boot, saves an edit with them, and drops them when the word is deleted', async () => {
    const io = createMemoryDictionaryIo(
      serializeDictionaryFile(['Voxloom', 'Postgres'], { Voxloom: ['box loom'] }),
    );
    const user = userEvent.setup();
    renderPersisted(io);
    await user.click(await screen.findByRole('button', { name: 'Dictionary' }));
    expect(await screen.findByText('Also heard as: box loom')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit Voxloom' }));
    await user.type(screen.getByLabelText('Also heard as (optional)'), ', voks loom');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(JSON.parse(io.snapshot()!).aliases).toEqual({ Voxloom: ['box loom', 'voks loom'] });
    });
    await user.click(screen.getByRole('button', { name: 'Delete Voxloom' }));
    await waitFor(() => {
      expect(JSON.parse(io.snapshot()!)).toEqual({ version: 1, words: ['Postgres'] });
    });
  });

  it('a file without aliases is not rewritten with an aliases key', async () => {
    const raw = serializeDictionaryFile(['Voxloom']);
    const io = createMemoryDictionaryIo(raw);
    const user = userEvent.setup();
    renderPersisted(io);
    await user.click(await screen.findByRole('button', { name: 'Dictionary' }));
    await screen.findByRole('button', { name: 'Edit Voxloom' });
    expect(io.snapshot()).toBe(raw);
  });
});

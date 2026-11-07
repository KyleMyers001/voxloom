import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../src/app/AppContext';
import { BootHydratePlaceholder } from '../../src/app/shell/BootHydratePlaceholder';
import { initialWords } from '../../src/domain/fixtures';
import { Dictionary } from '../../src/features/dictionary/Dictionary';
import { createDictionaryStore, createMemoryDictionaryIo } from '../../src/services/dictionary';
import { newestFirst } from '../../src/services/dictionary/format';
import { renderWithApp } from './testUtils';

describe('Dictionary compact list', () => {
  it('sorts and filters the view without rewriting oldest-first stored bytes or recognition priority', async () => {
    const raw = '{"version":1,"words":["Zebra","API","async"]}\n';
    const io = createMemoryDictionaryIo(raw);
    const store = createDictionaryStore(io);
    const save = vi.spyOn(store, 'save');
    const user = userEvent.setup();
    render(<AppProvider dictionaryPersistence={{ enabled: true, store }}><Dictionary /></AppProvider>);
    const list = await screen.findByRole('list', { name: 'Dictionary words, alphabetical' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3));
    expect(within(list).getAllByRole('button', { name: /^Edit / }).map((button) => button.getAttribute('aria-label')))
      .toEqual(['Edit API', 'Edit async', 'Edit Zebra']);
    await user.type(screen.getByRole('searchbox'), 'api');
    expect(screen.getByText('1 of 3 words')).toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox'));
    await user.click(screen.getByRole('button', { name: 'Edit Zebra' }));
    await user.keyboard('{Escape}');
    expect(save).not.toHaveBeenCalled();
    expect(io.snapshot()).toBe(raw);
    expect(newestFirst(JSON.parse(io.snapshot()!).words)).toEqual(['async', 'API', 'Zebra']);
  });

  it('names one alphabetical list and keeps its spelling header and range in sync with search', async () => {
    const user = userEvent.setup();
    const original = [...initialWords];
    renderWithApp(<Dictionary />);
    const list = screen.getByRole('list', { name: 'Dictionary words, alphabetical' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(initialWords.length);
    expect(screen.getByText('Canonical spelling')).toBeInTheDocument();
    expect(screen.getByText('A–Z')).toBeInTheDocument();
    expect(screen.getByText('Alphabetical order')).toBeInTheDocument();
    expect(screen.getByText('JSON — TypeScript')).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')[0]).not.toHaveAttribute('tabindex');
    await user.type(screen.getByRole('searchbox'), 'post');
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Postgres — Postgres')).toBeInTheDocument();
    expect(screen.getByText(`1 of ${initialWords.length} words`)).toBeInTheDocument();
    expect(initialWords).toEqual(original);
  });

  it('shows the word count, filtered count and row actions', async () => {
    const user = userEvent.setup();
    const { container } = renderWithApp(<Dictionary />);
    expect(screen.getByText(`${initialWords.length} words`)).toBeInTheDocument();
    expect(container.querySelectorAll('.term-grid .term-row')).toHaveLength(initialWords.length);
    const first = initialWords[0];
    expect(screen.getByRole('button', { name: `Edit ${first}` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Delete ${first}` })).toHaveClass('ib--danger');
    await user.type(screen.getByRole('searchbox', { name: 'Search dictionary' }), first);
    expect(screen.getByText(new RegExp(`of ${initialWords.length} words$`))).toBeInTheDocument();
  });

  it('distinguishes no-match from an empty dictionary', async () => {
    const user = userEvent.setup();
    renderWithApp(<Dictionary />);
    await user.type(screen.getByRole('searchbox'), 'zzz-none');
    expect(screen.getByText('No words found.')).toBeInTheDocument();
    expect(screen.getByText('Try another search.')).toBeInTheDocument();
    expect(screen.queryByText('No words yet')).toBeNull();
  });

  it('focuses the Word field when the add/edit sheet opens', async () => {
    const user = userEvent.setup();
    renderWithApp(<Dictionary />);
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    expect(screen.getByRole('textbox', { name: 'Word' })).toHaveFocus();
  });

  it('marks the field invalid and links the error', async () => {
    const user = userEvent.setup();
    renderWithApp(<Dictionary />);
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const field = screen.getByLabelText('Word');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Enter a word.');
  });
});

describe('BootHydratePlaceholder', () => {
  it('is busy with a Loading… status and the page title', () => {
    render(<BootHydratePlaceholder title="Dictionary" />);
    expect(screen.getByRole('heading', { name: 'Dictionary' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expect(screen.getByText('Loading saved data for this device…')).toBeInTheDocument();
  });
});

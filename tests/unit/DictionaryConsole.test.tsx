import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { BootHydratePlaceholder } from '../../src/app/shell/BootHydratePlaceholder';
import { initialWords } from '../../src/domain/fixtures';
import { Dictionary } from '../../src/features/dictionary/Dictionary';
import { renderWithApp } from './testUtils';

describe('Dictionary console layout (UI PR 5)', () => {
  it('shows the word count, filtered count and tile actions', async () => {
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

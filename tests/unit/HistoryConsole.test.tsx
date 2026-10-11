import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { History } from '../../src/features/history/History';
import { createRecords } from '../../src/domain/fixtures';
import type { HistoryStatus } from '../../src/domain/types';
import { isTauriEnv } from '../../src/services/capture/captureService';
import { renderWithApp } from './testUtils';

const initialRecords = createRecords(0);

afterEach(() => vi.mocked(isTauriEnv).mockReturnValue(false));

const rows = () => screen.queryAllByRole('article');
const statuses: HistoryStatus[] = ['inserted', 'copied', 'failed', 'unverified'];

describe('History segmented filter (UI PR 4)', () => {
  it('shows exactly the records the old select showed for each status', () => {
    renderWithApp(<History onToast={vi.fn()} />);
    expect(rows()).toHaveLength(initialRecords.length);
    for (const status of statuses) {
      fireEvent.click(screen.getByRole('radio', { name: status[0].toUpperCase() + status.slice(1) }));
      const expected = initialRecords.filter((r) => r.status === status).length;
      expect(rows(), status).toHaveLength(expected);
      rows().forEach((row) => expect(row.querySelector('.badge')?.getAttribute('data-status')).toBe(status));
    }
    fireEvent.click(screen.getByRole('radio', { name: 'All' }));
    expect(rows()).toHaveLength(initialRecords.length);
  });

  it('combines with search, shows the empty state and is keyboard-operable', async () => {
    const user = userEvent.setup();
    renderWithApp(<History onToast={vi.fn()} />);
    await user.type(screen.getByRole('searchbox', { name: 'Search history' }), 'zzz-no-match');
    expect(rows()).toHaveLength(0);
    expect(screen.getByText('No history matches these filters')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(rows()).toHaveLength(initialRecords.length);
    screen.getByRole('radio', { name: 'All' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Inserted' })).toHaveAttribute('aria-checked', 'true');
    expect(rows()).toHaveLength(initialRecords.filter((r) => r.status === 'inserted').length);
  });

  it('renders badge, meta and notes per row; Retry only in the browser', () => {
    vi.mocked(isTauriEnv).mockReturnValue(true);
    renderWithApp(<History onToast={vi.fn()} />);
    expect(screen.getByText(/Audio isn’t saved/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Failed' }));
    const row = rows()[0];
    expect(within(row).getByText('Failed')).toHaveClass('badge');
    expect(within(row).getByText(/No audio retry available/)).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Retry transcription' })).toBeNull();
    expect(within(row).getByRole('button', { name: 'Delete transcript' })).toBeInTheDocument();
  });
});

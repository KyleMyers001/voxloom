import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DictationRecord } from '../../src/domain/types';
import { History } from '../../src/features/history/History';
import { parseHistoryJson } from '../../src/services/history';

let records: DictationRecord[] = [];
vi.mock('../../src/app/AppContext', () => ({
  useApp: () => ({
    clipboard: { copy: vi.fn() },
    dictation: { retry: vi.fn() },
    history: { delete: vi.fn() },
    now: () => 1000,
    state: { records, dictation: { kind: 'ready' } },
  }),
}));

const row = {
  createdAt: 1000, durationSeconds: 1, id: 'metadata', model: null,
  recoveryExpiresAt: null, status: 'copied', style: 'formal', text: 'Final words.',
};

function renderHistory(version: number, record: unknown) {
  const parsed = parseHistoryJson(JSON.stringify({ version, records: [record] }));
  if (!parsed.ok) throw new Error(parsed.error);
  records = parsed.file.records;
  render(<History onToast={vi.fn()} />);
}

describe('History metadata presentation', () => {
  it('hides legacy migration bookkeeping without deleting it', () => {
    renderHistory(1, row);
    expect(screen.getByText('Final words.')).toBeInTheDocument();
    expect(screen.queryByText(/Cleanup:/)).not.toBeInTheDocument();
    expect(records[0].cleanup?.reason).toBe('migrated from history v1');
  });

  it('shows unavailable provenance while retaining raw/final and delivery', () => {
    renderHistory(2, { ...row, rawText: 'original words', cleanup: { version: 99 } });
    expect(screen.getByText('Final words.')).toBeInTheDocument();
    expect(screen.getByText('original words')).toBeInTheDocument();
    expect(screen.getByText(/Cleanup: unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/1s · Copied/)).toBeInTheDocument();
  });
});

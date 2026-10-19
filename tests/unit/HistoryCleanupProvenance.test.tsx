// BUS-16 PR 2c: History says whether a row was cleaned up or kept as said.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { skippedCleanupProvenance } from '../../src/domain/cleanup';
import type { CleanupProvenance, DictationRecord } from '../../src/domain/types';
import { HistoryRow } from '../../src/features/history/HistoryRow';
import { cleanupLabel } from '../../src/features/history/cleanupProvenance';

const provenance = (overrides: Partial<CleanupProvenance>): CleanupProvenance => ({
  ...skippedCleanupProvenance(), ...overrides,
});

function row(overrides: Partial<DictationRecord>) {
  const record: DictationRecord = {
    createdAt: 1_800_000_000_000, durationSeconds: 3, id: 'r1', model: 'whisper-tiny.en',
    recoveryExpiresAt: null, status: 'inserted', style: 'formal', text: 'Send it.', ...overrides,
  };
  const onCopy = vi.fn();
  render(<HistoryRow canStart currentTime={0} isNative onCopy={onCopy} onDelete={vi.fn()} onRetry={vi.fn()} record={record} />);
  return { onCopy };
}

describe('History cleanup provenance', () => {
  it('marks a cleaned row and reveals what was said', async () => {
    const user = userEvent.setup();
    const { onCopy } = row({ cleanup: provenance({ status: 'cleaned' }), rawText: 'um send it' });
    expect(screen.getByText('· Cleaned up locally')).toBeInTheDocument();
    expect(screen.getByText('um send it')).not.toBeVisible();
    await user.click(screen.getByText('Show what you said'));
    expect(screen.getByText('um send it')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Copy transcript' }));
    expect(onCopy).toHaveBeenCalledWith('Send it.');
  });

  it('says the original was kept on fallback, with the reason', () => {
    row({ cleanup: provenance({ reason: 'invalid-output', status: 'fallback' }), rawText: 'Send it.' });
    expect(screen.getByText('· Original kept · cleanup changed your words')).toBeInTheDocument();
    expect(screen.queryByText('Show what you said')).not.toBeInTheDocument();
  });

  it.each([
    ['skipped', provenance({}), 'um send it'],
    ['legacy v1', provenance({ promptVersion: 'legacy-v1' }), 'Send it.'],
    ['unavailable', provenance({ status: 'unavailable' }), 'um send it'],
    ['missing', undefined, 'um send it'],
  ])('shows nothing extra for a %s row, even when rawText differs', (_label, cleanup, rawText) => {
    row({ cleanup, rawText });
    expect(screen.queryByText(/Cleaned up locally|Original kept/)).not.toBeInTheDocument();
    expect(screen.queryByText('Show what you said')).not.toBeInTheDocument();
  });

  it.each([
    ['timeout', 'cleanup timed out'],
    ['model-missing', 'cleanup model missing'],
    ['runtime-error', 'cleanup failed'],
    ['context-overflow', 'too long to clean up'],
    ['cancelled', 'cleanup was interrupted'],
    ['something-new', 'cleanup failed'],
    [null, 'cleanup failed'],
  ])('labels fallback reason %s', (reason, label) => {
    expect(cleanupLabel(provenance({ reason, status: 'fallback' }))).toBe(`Original kept · ${label}`);
  });
});

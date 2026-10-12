import type { HistoryStatus } from '../domain/types';

export type BadgeStatus = HistoryStatus | 'missing' | 'downloading' | 'available';

const labels: Record<BadgeStatus, string> = {
  inserted: 'Inserted',
  copied: 'Copied',
  failed: 'Failed',
  unverified: 'Unverified',
  missing: 'Not downloaded',
  downloading: 'Downloading',
  available: 'On disk',
};

/** Status pill. Text always states the status; color only reinforces it. */
export function Badge({ status, children }: { status: BadgeStatus; children?: string }) {
  return <span className={`badge badge--${status}`} data-status={status}>{children ?? labels[status]}</span>;
}

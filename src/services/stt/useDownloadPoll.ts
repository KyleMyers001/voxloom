/// BUS-56: after a Models remount, a download started by an earlier mount is
/// only visible as a backend `downloading` status; this instance has no
/// promise to await and progress events carry no failure. Poll the list while
/// such a download is running so the row (and any lock derived from it)
/// clears when it finishes, fails or is canceled.

import { useEffect } from 'react';

import type { SttModelInfo } from './types';

export const DOWNLOAD_POLL_MS = 1000;

/**
 * BUS-76: the download started by any mount, set before
 * `stt_download_model` is invoked and cleared when it settles. Module level
 * so a Models remount inherits it before the backend reports `downloading`.
 */
export const pendingDownload: { modelId: string | null } = { modelId: null };

/**
 * Show the pending model as downloading while the backend still says missing.
 * Tagged `pending`: native cancel is a no-op until the download registers, so
 * the row must not offer Cancel yet.
 */
export function withPending(models: readonly SttModelInfo[]): readonly SttModelInfo[] {
  const id = pendingDownload.modelId;
  if (!id) return models;
  return models.map((m) => (m.id === id && m.status === 'missing' ? { ...m, pending: true, status: 'downloading' } : m));
}

export function useDownloadPoll(
  models: readonly SttModelInfo[],
  ownDownloadActive: boolean,
  refresh: () => Promise<void>,
): void {
  const orphaned = !ownDownloadActive && models.some((m) => m.status === 'downloading');
  useEffect(() => {
    if (!orphaned) return undefined;
    const timer = setInterval(() => {
      // A failed list keeps the last rows; the next tick tries again.
      void refresh().catch(() => {});
    }, DOWNLOAD_POLL_MS);
    return () => clearInterval(timer);
  }, [orphaned, refresh]);
}

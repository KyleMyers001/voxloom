/// BUS-56: after a Models remount, a download started by an earlier mount is
/// only visible as a backend `downloading` status; this instance has no
/// promise to await and progress events carry no failure. Poll the list while
/// such a download is running so the row (and any lock derived from it)
/// clears when it finishes, fails or is canceled.

import { useEffect } from 'react';

import type { SttModelInfo } from './types';

export const DOWNLOAD_POLL_MS = 1000;

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

/**
 * Ids deleted between a history reload being enqueued and finishing. A reload
 * merges disk rows into memory, so it must drop these or an explicit Delete is
 * undone. A reload can wait behind an in-flight save, so its set is opened
 * when it is enqueued, not when it starts (Codex P2 4394604089).
 */
export type ReloadTombstones = Set<Set<string>>;

/**
 * Open a tombstone set now and return the job that runs `reload` with it. The
 * set is closed when the job settles, whether or not the reload did any work.
 */
export function trackReload(
  registry: ReloadTombstones,
  reload: (deleted: Set<string>) => Promise<void>,
): () => Promise<void> {
  const deleted = new Set<string>();
  registry.add(deleted);
  return async () => {
    try {
      await reload(deleted);
    } finally {
      registry.delete(deleted);
    }
  };
}

/** Record a Delete in every reload that is queued or running. */
export function recordReloadDeletion(registry: ReloadTombstones, id: string): void {
  for (const deleted of registry) deleted.add(id);
}

import { invoke } from '@tauri-apps/api/core';

/** Store files that can be preserved before an unreadable file is replaced. */
export type BackupStore = 'dictionary' | 'history' | 'settings';

/**
 * Copy the on-disk store file aside (Tauri `store_backup`). Resolves to the
 * backup path, or `null` when no file existed. Never modifies the original.
 */
export function tauriBackup(store: BackupStore): () => Promise<string | null> {
  return () => invoke<string | null>('store_backup', { store });
}

export type BackupOutcome =
  | { ok: true; path: string }
  | { ok: false; error: string };

/** Run an optional IO backup hook, never throwing. */
export async function runBackup(
  backup: (() => Promise<string | null>) | undefined,
): Promise<BackupOutcome> {
  if (!backup) return { error: 'no backup support', ok: false };
  try {
    const path = await backup();
    // No file copied (vanished, not a regular file, unreadable dir): that
    // is not a backup, so nothing may be overwritten on its strength.
    if (!path) return { error: 'no file was backed up', ok: false };
    return { ok: true, path };
  } catch (error: unknown) {
    return {
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  }
}

/** Memory backup list for in-memory IOs (tests / non-Tauri shells). */
export function memoryBackups(read: () => string | null) {
  const backups: string[] = [];
  return {
    backup: async () => {
      const data = read();
      if (data === null) return null;
      // Mirror the Tauri command: an identical newest backup is reused.
      if (backups[backups.length - 1] !== data) backups.push(data);
      return `memory-backup-${backups.length}`;
    },
    backups: () => [...backups],
  };
}

export function describeBackup(outcome: BackupOutcome): string {
  if (!outcome.ok) return ` (backup failed: ${outcome.error}; file left untouched)`;
  return ` (original kept at ${outcome.path})`;
}

/**
 * True when `raw` is well-formed JSON carrying a `version` this build does
 * not understand (e.g. a future v99). Such files are written by another
 * build and must never be replaced with defaults, even after a backup.
 * Truly corrupt JSON (or no version at all) returns false.
 */
export function hasUnknownVersion(
  raw: string,
  readable: readonly unknown[],
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  if (!('version' in parsed)) return false;
  return !readable.includes((parsed as { version: unknown }).version);
}

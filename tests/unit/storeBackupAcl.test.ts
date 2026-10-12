// BUS-42: store_backup must be callable from the main window only (it is how
// an unreadable history/settings/dictionary file is preserved before any
// write). Settings and overlay windows must not be granted it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '../../src-tauri');
const cap = (name: string) =>
  JSON.parse(readFileSync(join(root, 'capabilities', `${name}.json`), 'utf8')) as {
    permissions: string[];
  };

describe('store_backup ACL', () => {
  it('is declared as an app command in build.rs', () => {
    expect(readFileSync(join(root, 'build.rs'), 'utf8')).toContain('"store_backup"');
  });

  it('is granted to main only', () => {
    expect(cap('main').permissions).toContain('allow-store-backup');
    expect(cap('settings').permissions).not.toContain('allow-store-backup');
    expect(cap('overlay').permissions).not.toContain('allow-store-backup');
  });
});

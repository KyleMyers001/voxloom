/// BUS-75 / BUS-80: the public repo keeps people's names out of source and docs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const NAME = ['Ky', 'le'].join('');
/** Source trees and top-level docs. Walk skips node_modules, target, and build output. */
const ROOTS = [
  'src',
  'src-tauri',
  'tests',
  'docs',
  'README.md',
  'PRIVACY.md',
  'CONTRIBUTING.md',
];
const SKIP_DIRS = new Set([
  'node_modules',
  'target',
  'dist',
  'build',
  '.playwright-browsers',
  'artifacts',
]);
const TEXT_EXT = /\.(tsx?|jsx?|rs|md|css|json|toml|plist)$/;

function files(path: string): string[] {
  const st = statSync(path);
  if (st.isFile()) return [path];
  return readdirSync(path).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    return files(join(path, name));
  });
}

describe('no personal attribution (BUS-75 / BUS-80)', () => {
  it('src, src-tauri, tests and docs never name a person', () => {
    const hits = ROOTS.flatMap(files)
      .filter((f) => TEXT_EXT.test(f))
      .filter((f) => new RegExp(`\\b${NAME}\\b`).test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('README sentences end with a period', () => {
    const readme = readFileSync('README.md', 'utf8');
    expect(readme).toContain('bundle.macOS.minimumSystemVersion`.');
  });
});

/// BUS-75: the public repo keeps people's names out of source, tests and README.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const NAME = ['Ky', 'le'].join('');
const ROOTS = ['src', 'tests', 'README.md'];

function files(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((name) => files(join(path, name)));
}

describe('no personal attribution (BUS-75)', () => {
  it('src, tests and README never name a person', () => {
    const hits = ROOTS.flatMap(files)
      .filter((f) => /\.(tsx?|md|css|json)$/.test(f))
      .filter((f) => new RegExp(`\\b${NAME}\\b`).test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('README sentences end with a period', () => {
    const readme = readFileSync('README.md', 'utf8');
    expect(readme).toContain('bundle.macOS.minimumSystemVersion`.');
  });
});

/// BUS-79 / BUS-83: the undici override must stay at or above the patched 6.28.1.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

/** Compare full major.minor.patch; returns true when a >= b. */
function semverAtLeast(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return true;
}

describe('undici security floor (BUS-79 / BUS-83)', () => {
  it('jsdom resolves undici 6.28.1 or newer', () => {
    const jsdomDir = require.resolve('jsdom/package.json');
    const { version } = createRequire(jsdomDir)('undici/package.json') as {
      version: string;
    };
    expect(semverAtLeast(version, '6.28.1')).toBe(true);
  });

  it('compares the full patch: 6.28.0 fails the floor, 6.28.1 and 6.29.0 pass', () => {
    expect(semverAtLeast('6.28.0', '6.28.1')).toBe(false);
    expect(semverAtLeast('6.28.1', '6.28.1')).toBe(true);
    expect(semverAtLeast('6.29.0', '6.28.1')).toBe(true);
    expect(semverAtLeast('7.0.0', '6.28.1')).toBe(true);
  });
});

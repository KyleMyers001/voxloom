/// BUS-79: the undici override must stay at or above the patched 6.28.1.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('undici security floor (BUS-79)', () => {
  it('jsdom resolves undici 6.28.1 or newer', () => {
    const jsdomDir = require.resolve('jsdom/package.json');
    const { version } = createRequire(jsdomDir)('undici/package.json') as { version: string };
    const [major, minor] = version.split('.').map(Number);
    expect(major > 6 || (major === 6 && minor >= 28)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM release script without type declarations
import { SEMVER } from '../../scripts/release/versions.mjs';

const re = SEMVER as RegExp;

describe('release SEMVER', () => {
  it.each([
    '0.0.0',
    '0.1.0',
    '1.2.3',
    '10.20.30',
    '1.2.3-alpha',
    '1.2.3-alpha.1',
    '1.2.3-0.3.7',
    '1.2.3-x-y-z.--',
    '1.2.3-rc.1+build.5',
    '1.2.3+20261011.sha.abc',
  ])('accepts %s', (version) => {
    expect(re.test(version)).toBe(true);
  });

  it.each([
    '',
    '1',
    '1.2',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    'v1.2.3',
    '1.2.3-',
    '1.2.3-.',
    '1.2.3-a..b',
    '1.2.3-01',
    '1.2.3+',
    '1.2.3+a..b',
    '1.2.3 ',
  ])('rejects %s', (version) => {
    expect(re.test(version)).toBe(false);
  });
});

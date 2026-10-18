import { spawnSync } from 'child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// scripts/release/package-macos.sh must hold only signed builds to the
// Developer ID / Team ID checks (BUS-96). The real script is copied into a
// temp tree next to a stub macos-assert-entitlements.sh that records the
// signing env it sees and exits 3, so packaging stops right after it.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const ASSERT_STUB = `#!/usr/bin/env bash
{
  echo "identity=\${APPLE_SIGNING_IDENTITY-<unset>}"
  echo "team=\${APPLE_TEAM_ID-<unset>}"
} > "$STUB_OUT"
exit 3
`;

const SIGNING_ENV = {
  APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example Dev (ABCDE12345)',
  APPLE_TEAM_ID: 'ABCDE12345',
};

let dir: string;

function runPackage(signed: 'true' | 'false') {
  const out = join(dir, 'assert-env');
  const result = spawnSync(
    'bash',
    [
      join(dir, 'scripts/release/package-macos.sh'),
      'universal-apple-darwin',
      '0.1.0',
      signed,
    ],
    {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', STUB_OUT: out, ...SIGNING_ENV },
    },
  );
  return { status: result.status, seen: readFileSync(out, 'utf8') };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vx-package-'));
  mkdirSync(join(dir, 'scripts/release'), { recursive: true });
  copyFileSync(
    resolve(root, 'scripts/release/package-macos.sh'),
    join(dir, 'scripts/release/package-macos.sh'),
  );
  const stub = join(dir, 'scripts/macos-assert-entitlements.sh');
  writeFileSync(stub, ASSERT_STUB);
  chmodSync(stub, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('package-macos.sh entitlements check env', () => {
  it('strips the signing identity and Team ID for unsigned builds', () => {
    const r = runPackage('false');
    expect(r.status).toBe(3);
    expect(r.seen).toBe('identity=<unset>\nteam=<unset>\n');
  });

  it('keeps the signing identity and Team ID for signed builds', () => {
    const r = runPackage('true');
    expect(r.status).toBe(3);
    expect(r.seen).toBe(
      `identity=${SIGNING_ENV.APPLE_SIGNING_IDENTITY}\n` +
        `team=${SIGNING_ENV.APPLE_TEAM_ID}\n`,
    );
  });
});

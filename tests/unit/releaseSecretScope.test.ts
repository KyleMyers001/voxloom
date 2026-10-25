import { spawnSync } from 'child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// BUS-119: the Apple signing secrets must never reach the cleanup worker
// build or the app's cargo/npm compile, only Tauri's bundle (sign and
// notarize) phase. The real scripts run in a temp tree where `npm` and
// build-worker.sh are stubs that record their arguments and APPLE_* env.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const RECORD_STUB = `#!/usr/bin/env bash
{
  echo "== $(basename "$0") $*"
  env | grep '^APPLE_' | sort || true
} >> "$STUB_OUT"
`;

// Prints the arches the test asks for, like `lipo -archs <binary>`.
const LIPO_STUB = `#!/usr/bin/env bash
echo "== lipo $*" >> "$STUB_OUT"
echo "$STUB_ARCHS"
`;

const SECRETS = {
  APPLE_CERTIFICATE: 'cDEy',
  APPLE_CERTIFICATE_PASSWORD: 'cert-pw',
  APPLE_API_KEY: 'KEYID12345',
  APPLE_API_ISSUER: 'issuer-uuid',
  APPLE_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----',
  APPLE_ID: 'dev@example.com',
  APPLE_PASSWORD: 'app-pw',
};
const IDENTITY = {
  APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example Dev (ABCDE12345)',
  APPLE_TEAM_ID: 'ABCDE12345',
};
const SIGNED_ENV = {
  ...IDENTITY,
  APPLE_CERTIFICATE: SECRETS.APPLE_CERTIFICATE,
  APPLE_CERTIFICATE_PASSWORD: SECRETS.APPLE_CERTIFICATE_PASSWORD,
  APPLE_API_KEY: SECRETS.APPLE_API_KEY,
  APPLE_API_ISSUER: SECRETS.APPLE_API_ISSUER,
  APPLE_API_PRIVATE_KEY: SECRETS.APPLE_API_PRIVATE_KEY,
};

let dir: string;

function run(script: string, env: Record<string, string>) {
  // Deliberately not GITHUB_ACTIONS: tests that need it pass it in env.
  const out = join(dir, 'stub-out');
  const ghEnv = join(dir, 'github-env');
  const result = spawnSync(
    'bash',
    [join(dir, 'scripts/release', script), 'universal-apple-darwin'],
    {
      encoding: 'utf8',
      env: {
        PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
        STUB_OUT: out,
        GITHUB_ENV: ghEnv,
        RUNNER_TEMP: dir,
        STUB_ARCHS: 'x86_64 arm64',
        ...env,
      },
    },
  );
  const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  return { ...result, seen: read(out), githubEnv: read(ghEnv) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vx-secret-scope-'));
  mkdirSync(join(dir, 'scripts/release'), { recursive: true });
  mkdirSync(join(dir, 'bin'));
  for (const name of ['build-macos.sh', 'bundle-macos.sh', 'signing-env.sh']) {
    copyFileSync(
      resolve(root, 'scripts/release', name),
      join(dir, 'scripts/release', name),
    );
  }
  for (const stub of ['bin/npm', 'scripts/release/build-worker.sh']) {
    writeFileSync(join(dir, stub), RECORD_STUB);
    chmodSync(join(dir, stub), 0o755);
  }
  writeFileSync(join(dir, 'bin/lipo'), LIPO_STUB);
  chmodSync(join(dir, 'bin/lipo'), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('build-macos.sh (compile phase)', () => {
  it('builds the worker and app with no APPLE_* variable at all', () => {
    const r = run('build-macos.sh', { ...SECRETS, ...IDENTITY });
    expect(r.status).toBe(0);
    expect(r.seen).toBe(
      '== build-worker.sh universal-apple-darwin\n' +
        '== npm run tauri -- build --no-bundle --target ' +
        'universal-apple-darwin --config src-tauri/tauri.worker.conf.json ' +
        '-- --locked --features whisper\n' +
        '== lipo -archs src-tauri/target/universal-apple-darwin/release/voxloom\n',
    );
  });

  it('fails when the universal app binary lacks an arch', () => {
    const r = run('build-macos.sh', { STUB_ARCHS: 'arm64' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('universal app binary has archs \'arm64\'');
  });

  it('checks the arches under an absolute CARGO_TARGET_DIR', () => {
    const r = run('build-macos.sh', { CARGO_TARGET_DIR: '/tmp/vx-target' });
    expect(r.status).toBe(0);
    expect(r.seen).toContain(
      '== lipo -archs /tmp/vx-target/universal-apple-darwin/release/voxloom\n',
    );
  });
});

describe('bundle-macos.sh (sign and notarize phase)', () => {
  it('only bundles, with the signing secrets and the key as a file', () => {
    const keyPath = join(dir, 'AuthKey_KEYID12345.p8');
    // A stale, world-readable key from an earlier run is replaced, not reused.
    writeFileSync(keyPath, 'old key', { mode: 0o644 });
    const r = run('bundle-macos.sh', { ...SIGNED_ENV, GITHUB_ACTIONS: 'true' });
    expect(r.status).toBe(0);
    expect(r.seen).toBe(
      '== npm run tauri -- bundle --target universal-apple-darwin ' +
        '--bundles app,dmg --config src-tauri/tauri.worker.conf.json ' +
        '--features whisper\n' +
        `APPLE_API_ISSUER=${SECRETS.APPLE_API_ISSUER}\n` +
        `APPLE_API_KEY=${SECRETS.APPLE_API_KEY}\n` +
        `APPLE_API_KEY_PATH=${keyPath}\n` +
        `APPLE_CERTIFICATE=${SECRETS.APPLE_CERTIFICATE}\n` +
        `APPLE_CERTIFICATE_PASSWORD=${SECRETS.APPLE_CERTIFICATE_PASSWORD}\n` +
        `APPLE_SIGNING_IDENTITY=${IDENTITY.APPLE_SIGNING_IDENTITY}\n` +
        `APPLE_TEAM_ID=${IDENTITY.APPLE_TEAM_ID}\n`,
    );
    expect(readFileSync(keyPath, 'utf8')).toBe(SECRETS.APPLE_API_PRIVATE_KEY);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(r.githubEnv).toBe(`SIGNED=true\nAPPLE_API_KEY_PATH=${keyPath}\n`);
  });

  it('removes the key file on exit outside Actions', () => {
    const r = run('bundle-macos.sh', SIGNED_ENV);
    expect(r.status).toBe(0);
    expect(r.seen).toContain('APPLE_API_KEY_PATH=');
    expect(existsSync(join(dir, 'AuthKey_KEYID12345.p8'))).toBe(false);
  });

  it('bundles ad-hoc with no APPLE_* when no secrets are set', () => {
    const r = run('bundle-macos.sh', { APPLE_TEAM_ID: 'ABCDE12345' });
    expect(r.status).toBe(0);
    expect(r.seen).toBe(
      '== npm run tauri -- bundle --target universal-apple-darwin ' +
        '--bundles app,dmg --config src-tauri/tauri.worker.conf.json ' +
        '--features whisper\n',
    );
    expect(r.githubEnv).toBe('SIGNED=false\n');
  });

  it('stops before bundling on a partial secret set', () => {
    const r = run('bundle-macos.sh', {
      APPLE_CERTIFICATE: SECRETS.APPLE_CERTIFICATE,
    });
    expect(r.status).not.toBe(0);
    expect(r.seen).toBe('');
  });
});

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
        '-- --locked --features whisper\n',
    );
  });
});

describe('bundle-macos.sh (sign and notarize phase)', () => {
  it('only bundles, with the signing secrets and the key as a file', () => {
    const r = run('bundle-macos.sh', SIGNED_ENV);
    expect(r.status).toBe(0);
    const keyPath = join(dir, 'AuthKey_KEYID12345.p8');
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

describe('release.yml secret scope', () => {
  const workflow = readFileSync(
    resolve(root, '.github/workflows/release.yml'),
    'utf8',
  );
  const step = (name: string) => {
    const start = workflow.indexOf(`- name: ${name}\n`);
    expect(start).toBeGreaterThan(-1);
    const next = workflow.indexOf('\n      - ', start + 1);
    return workflow.slice(start, next === -1 ? undefined : next);
  };

  it('gives the compile step no secrets', () => {
    expect(step('Compile app and worker (no secrets)')).not.toContain(
      'secrets.',
    );
  });

  it('gives the Apple secrets to the bundle step', () => {
    expect(step('Bundle, sign and notarize')).toContain(
      'secrets.APPLE_CERTIFICATE ',
    );
  });
});

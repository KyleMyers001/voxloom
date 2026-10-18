import { spawnSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

// scripts/release/signing-env.sh decides signed vs ad-hoc release builds.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = resolve(root, 'scripts/release/signing-env.sh');

const CERT = {
  APPLE_CERTIFICATE: 'cDEy',
  APPLE_CERTIFICATE_PASSWORD: 'pw',
  APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example Dev (ABCDE12345)',
};
const API_KEY = {
  APPLE_API_KEY: 'KEYID12345',
  APPLE_API_ISSUER: 'issuer-uuid',
  APPLE_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----',
};
const APPLE_ID = { APPLE_ID: 'dev@example.com', APPLE_PASSWORD: 'app-pw' };
const TEAM = { APPLE_TEAM_ID: 'ABCDE12345' };

function run(env: Record<string, string>) {
  return spawnSync('bash', [script], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', ...env },
  });
}

describe('release signing-env.sh', () => {
  it('builds ad-hoc when no Apple secrets are set', () => {
    const r = run({});
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('false');
  });

  it('treats an empty secret as unset (GitHub passes "" for missing)', () => {
    const r = run({ APPLE_CERTIFICATE: '', APPLE_API_KEY: '' });
    expect(r.stdout.trim()).toBe('false');
  });

  it('builds ad-hoc when only the (non-secret) Team ID is set', () => {
    const r = run(TEAM);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('false');
  });

  it('signs with a certificate and an App Store Connect API key', () => {
    expect(run({ ...CERT, ...API_KEY }).stdout.trim()).toBe('true');
  });

  it('accepts APPLE_TEAM_ID alongside the API key', () => {
    const r = run({ ...CERT, ...API_KEY, ...TEAM });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('true');
  });

  it('signs with a certificate and Apple ID + Team ID', () => {
    expect(run({ ...CERT, ...APPLE_ID, ...TEAM }).stdout.trim()).toBe('true');
  });

  it('requires APPLE_TEAM_ID for Apple ID notarization', () => {
    const r = run({ ...CERT, ...APPLE_ID });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('APPLE_TEAM_ID is required');
  });

  it('rejects signing without notarization credentials', () => {
    const r = run(CERT);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('signing without notarization');
  });

  it('rejects notarization credentials without the certificate', () => {
    const r = run(API_KEY);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('APPLE_CERTIFICATE');
  });
});

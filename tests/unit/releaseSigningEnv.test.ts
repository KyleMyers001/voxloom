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

  it('signs with a certificate, Team ID and App Store Connect API key', () => {
    const r = run({ ...CERT, ...API_KEY, ...TEAM });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('true');
  });

  it('requires APPLE_TEAM_ID on the signed path with the API key', () => {
    const r = run({ ...CERT, ...API_KEY });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(
      'APPLE_TEAM_ID is required when any Developer ID certificate secret is set',
    );
  });

  it('requires APPLE_TEAM_ID when only the signing identity is set', () => {
    const r = run({
      APPLE_SIGNING_IDENTITY: CERT.APPLE_SIGNING_IDENTITY,
      ...API_KEY,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('APPLE_TEAM_ID is required');
  });

  // Only the App Store Connect API key notarizes: Tauri prefers Apple ID
  // credentials over the key, so a set APPLE_ID must stop the build.
  it('rejects Apple ID notarization, even next to the API key', () => {
    for (const env of [
      { ...CERT, ...APPLE_ID, ...TEAM },
      { ...CERT, ...API_KEY, ...TEAM, APPLE_ID: APPLE_ID.APPLE_ID },
      { ...CERT, ...API_KEY, ...TEAM, APPLE_PASSWORD: 'app-pw' },
    ]) {
      const r = run(env);
      expect(r.status).not.toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('Apple ID notarization is not supported');
    }
  });

  it('ignores an empty APPLE_ID and APPLE_PASSWORD on the API key path', () => {
    const r = run({ ...CERT, ...API_KEY, ...TEAM, APPLE_ID: '',
      APPLE_PASSWORD: '' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('true');
  });

  it('requires the whole API key trio', () => {
    for (const name of Object.keys(API_KEY)) {
      const r = run({ ...CERT, ...API_KEY, ...TEAM, [name]: '' });
      expect(r.status, name).not.toBe(0);
      expect(r.stderr).toContain(`${name} is required`);
    }
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

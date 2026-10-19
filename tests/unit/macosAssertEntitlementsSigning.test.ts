import { spawnSync } from 'child_process';
import {
  chmodSync,
  existsSync,
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

// Runs scripts/macos-assert-entitlements.sh on Linux against stub `uname`
// and `codesign` binaries, so the signing-identity handling (BUS-96) is
// tested without a Mac or a real certificate.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = resolve(root, 'scripts/macos-assert-entitlements.sh');

const DEV_ID = 'Developer ID Application: Example Dev (ABCDE12345)';

// The stub keeps the "current signature" in files under $STUB_DIR:
// `identity` holds the identity the .app was signed with ("-" = ad-hoc),
// `entitled` exists when entitlements are embedded. `calls` logs argv.
const CODESIGN_STUB = `#!/usr/bin/env bash
echo "$*" >> "$STUB_DIR/calls"
identity="$(cat "$STUB_DIR/identity" 2>/dev/null || echo -)"
if [[ "$1" == "--force" ]]; then
  sign_id="$3"; target="\${!#}"
  if [[ "$target" == *.app ]]; then
    printf '%s' "$sign_id" > "$STUB_DIR/identity"
    touch "$STUB_DIR/entitled"
  fi
  exit 0
fi
if [[ "$*" == *"--entitlements :-"* ]]; then
  [[ -f "$STUB_DIR/entitled" ]] &&
    echo '<key>com.apple.security.device.audio-input</key><true/>'
  exit 0
fi
{
  echo "Identifier=com.voxloom.prototype"
  if [[ "$identity" == "-" ]]; then
    echo "Signature=adhoc"
    echo "TeamIdentifier=not set"
  else
    echo "Authority=$identity"
    team="\${identity##*(}"; echo "TeamIdentifier=\${team%)}"
  fi
} >&2
`;

let dir: string;
let app: string;

function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync('bash', [script, ...args, app], {
    encoding: 'utf8',
    env: {
      PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
      STUB_DIR: dir,
      ...env,
    },
  });
  const callsFile = join(dir, 'calls');
  const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8') : '';
  const signCalls = calls.split('\n').filter((l) => l.startsWith('--force'));
  return { ...result, output: result.stdout + result.stderr, signCalls };
}

function signedWith(identity: string, entitled: boolean) {
  writeFileSync(join(dir, 'identity'), identity);
  if (entitled) writeFileSync(join(dir, 'entitled'), '');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vx-assert-'));
  mkdirSync(join(dir, 'bin'));
  for (const [name, body] of [
    ['uname', '#!/usr/bin/env bash\necho Darwin\n'],
    ['codesign', CODESIGN_STUB],
  ]) {
    writeFileSync(join(dir, 'bin', name), body);
    chmodSync(join(dir, 'bin', name), 0o755);
  }
  app = join(dir, 'Voxloom.app');
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents/MacOS/voxloom'), '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('macos-assert-entitlements signing identity', () => {
  it('repairs ad-hoc ("-") when no identity is set', () => {
    signedWith('-', false);
    const r = run(['--repair']);
    expect(r.status).toBe(0);
    expect(r.signCalls).toHaveLength(2);
    for (const call of r.signCalls) {
      expect(call).toMatch(/^--force --sign - --identifier com\.voxloom\.prototype --options runtime --entitlements /);
    }
  });

  it('repairs with APPLE_SIGNING_IDENTITY when it is set', () => {
    signedWith('-', false);
    const r = run(['--repair'], { APPLE_SIGNING_IDENTITY: DEV_ID });
    expect(r.status).toBe(0);
    expect(r.signCalls).toHaveLength(2);
    for (const call of r.signCalls) {
      expect(call).toContain(`--sign ${DEV_ID} --identifier`);
    }
    expect(r.output).toContain('OK: signed with a Developer ID identity');
  });

  it('refuses to re-sign ad-hoc over a Developer ID signature', () => {
    signedWith(DEV_ID, false);
    const r = run(['--repair']);
    expect(r.status).toBe(1);
    expect(r.signCalls).toHaveLength(0);
    expect(r.output).toContain('refusing to re-sign ad-hoc');
    expect(r.output).toContain('APPLE_SIGNING_IDENTITY');
  });

  it('fails when an identity is set but the app is ad-hoc signed', () => {
    signedWith('-', true);
    const r = run([], { APPLE_SIGNING_IDENTITY: DEV_ID });
    expect(r.status).toBe(1);
    expect(r.output).toContain('expected a Developer ID signature');
  });

  it('passes a Developer ID app whose team matches APPLE_TEAM_ID', () => {
    signedWith(DEV_ID, true);
    const r = run([], {
      APPLE_SIGNING_IDENTITY: DEV_ID,
      APPLE_TEAM_ID: 'ABCDE12345',
    });
    expect(r.status).toBe(0);
    expect(r.signCalls).toHaveLength(0);
    expect(r.output).toContain('OK: TeamIdentifier is ABCDE12345');
  });

  it('fails when TeamIdentifier does not match APPLE_TEAM_ID', () => {
    signedWith(DEV_ID, true);
    const r = run([], { APPLE_TEAM_ID: 'ZZZZZ99999' });
    expect(r.status).toBe(1);
    expect(r.output).toContain('expected TeamIdentifier=ZZZZZ99999');
  });

  it('keeps today\'s ad-hoc check passing with no identity set', () => {
    signedWith('-', true);
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.signCalls).toHaveLength(0);
  });
});

import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// release.yml guards (BUS-59, BUS-119): Apple secrets reach only the two
// steps that compile nothing, and a v* tag is released only from a commit
// on main, failing closed if that check doesn't pass.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  if?: string;
  'continue-on-error'?: unknown;
  'timeout-minutes'?: number;
}
interface Job {
  needs?: string | string[];
  if?: string;
  env?: Record<string, string>;
  environment?: string;
  'continue-on-error'?: unknown;
  'timeout-minutes'?: number;
  steps: Step[];
}
interface Workflow {
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}

const workflow = parse(
  readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8'),
) as Workflow;
const { jobs } = workflow;
const build = jobs['build-macos'];
const stepNamed = (name: string) => {
  const index = build.steps.findIndex((s) => s.name === name);
  expect(index, name).toBeGreaterThan(-1);
  return { index, step: build.steps[index] };
};
const usesSecrets = (value: unknown) =>
  JSON.stringify(value ?? {}).includes('secrets.');

const COMPILE = 'Compile app and worker (no secrets)';
const BUNDLE = 'Bundle, sign and notarize';
const PACKAGE = 'Package, verify and checksum';
const TAG_PUSH = 'github.event_name == \'push\' && github.ref_type == \'tag\'';

describe('release.yml secret scope (BUS-119)', () => {
  it('has no secrets at workflow or job level', () => {
    expect(usesSecrets(workflow.env)).toBe(false);
    for (const [name, job] of Object.entries(jobs)) {
      expect(usesSecrets(job.env), name).toBe(false);
    }
  });

  it('gives secrets only to the bundle and package steps', () => {
    const withSecrets = Object.values(jobs).flatMap((job) =>
      job.steps.filter(usesSecrets).map((s) => s.name),
    );
    expect(withSecrets).toEqual([BUNDLE, PACKAGE]);
  });

  // Only these exist in the 'release' Environment. Mapping any other name
  // hands tauri an empty variable: an empty APPLE_ID + APPLE_PASSWORD made
  // it try Apple ID notarization instead of the API key (HTTP 401).
  it('maps only Apple secrets that exist, never APPLE_ID/APPLE_PASSWORD', () => {
    const known = [
      'APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD',
      'APPLE_SIGNING_IDENTITY', 'APPLE_TEAM_ID', 'APPLE_API_KEY',
      'APPLE_API_ISSUER', 'APPLE_API_PRIVATE_KEY',
    ];
    for (const step of build.steps) {
      for (const [name, value] of Object.entries(step.env ?? {})) {
        if (!name.startsWith('APPLE_')) continue;
        expect(known, `${step.name}: ${name}`).toContain(name);
        expect(value, `${step.name}: ${name}`).toContain(`secrets.${name} `);
      }
    }
  });

  it('compiles, then bundles, then packages, each with its own script', () => {
    const compile = stepNamed(COMPILE);
    const bundle = stepNamed(BUNDLE);
    const pkg = stepNamed(PACKAGE);
    expect(compile.index).toBeLessThan(bundle.index);
    expect(bundle.index).toBeLessThan(pkg.index);
    expect(compile.step.run).toBe(
      'bash scripts/release/build-macos.sh "$TARGET"',
    );
    expect(bundle.step.run).toBe(
      'bash scripts/release/bundle-macos.sh "$TARGET"',
    );
    expect(pkg.step.run).toContain('scripts/release/package-macos.sh');
  });
});

describe('release.yml tag-on-main gate', () => {
  const gate = jobs['tag-on-main'];

  it('runs on every tag push, before any environment', () => {
    expect(gate.if).toBe(TAG_PUSH);
    expect(gate.environment).toBeUndefined();
    expect(gate.needs).toBeUndefined();
    expect(gate['continue-on-error']).toBeUndefined();
    expect(gate.steps[0].with?.['fetch-depth']).toBe(0);
  });

  it('fails closed: build-macos needs a passed check or a manual run', () => {
    expect(build.needs).toBe('tag-on-main');
    expect(build.if).toBe(
      '${{ !cancelled() && (needs.tag-on-main.result == \'success\' || ' +
        '(github.event_name == \'workflow_dispatch\' && ' +
        'needs.tag-on-main.result == \'skipped\')) }}',
    );
  });

  it('publishes only after the check and the build both passed', () => {
    const publish = jobs.publish;
    expect(publish.needs).toEqual(['tag-on-main', 'build-macos']);
    expect(publish.if).toBe(
      `${TAG_PUSH} && needs.tag-on-main.result == 'success' && ` +
        'needs.build-macos.result == \'success\'',
    );
  });

  // Runs the gate's own shell against a scratch repo with an origin/main.
  it('passes a commit on main and rejects one that is not', () => {
    const check = gate.steps.find((s) => s.run?.includes('merge-base'));
    expect(check?.if).toBeUndefined();
    expect(check?.['continue-on-error']).toBeUndefined();
    const repo = mkdtempSync(join(tmpdir(), 'vx-tag-gate-'));
    try {
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
      git('init', '-q');
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q',
        '--allow-empty', '-m', 'main');
      const onMain = git('rev-parse', 'HEAD');
      git('update-ref', 'refs/remotes/origin/main', onMain);
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q',
        '--allow-empty', '-m', 'side');
      const offMain = git('rev-parse', 'HEAD');
      const runGate = (sha: string) =>
        spawnSync('bash', ['-e', '-c', check?.run ?? 'exit 99'], {
          cwd: repo,
          encoding: 'utf8',
          env: { PATH: process.env.PATH, GITHUB_SHA: sha,
            GITHUB_REF_NAME: 'v0.0.0-test' },
        });
      expect(runGate(onMain).status).toBe(0);
      const rejected = runGate(offMain);
      expect(rejected.status).toBe(1);
      expect(rejected.stdout).toContain('is not on main');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// The first signed v0.1.0 run sat in Apple's notarization queue
// past the old 60-minute job limit. Both notarytool waits (app, then dmg)
// must fit in the job, and the job must fit GitHub's 360-minute cap.
describe('release.yml notarization time budget', () => {
  it('gives build-macos 180 minutes, under the hosted-runner cap', () => {
    expect(build['timeout-minutes']).toBe(180);
  });

  it('caps the bundle step so Package still has time for the dmg', () => {
    const bundle = stepNamed(BUNDLE).step['timeout-minutes'] ?? 0;
    expect(bundle).toBe(120);
    expect(stepNamed(PACKAGE).step['timeout-minutes']).toBeUndefined();
    expect(bundle).toBeLessThan(build['timeout-minutes'] ?? 0);
  });
});

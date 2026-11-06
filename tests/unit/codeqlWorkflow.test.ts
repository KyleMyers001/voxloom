import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Workflow {
  on: Record<string, unknown>;
  concurrency: { group: string; 'cancel-in-progress': string };
  jobs: {
    analyze: {
      'timeout-minutes': number;
      strategy: { 'fail-fast': boolean; matrix: { include: { language: string; 'build-mode': string; os: string }[] } };
      steps: Step[];
    };
  };
}

const workflow = parse(readFileSync('.github/workflows/codeql.yml', 'utf8')) as Workflow;
const job = workflow.jobs.analyze;
const steps = job.steps;
const named = (name: string) => {
  const step = steps.find((candidate) => candidate.name === name);
  expect(step, name).toBeDefined();
  return step!;
};
const init = steps.find((step) => step.uses?.startsWith('github/codeql-action/init@'))!;
const analyze = steps.find((step) => step.uses?.startsWith('github/codeql-action/analyze@'))!;

describe('CodeQL workflow', () => {
  it('retains every currently scanned language and uses manual Swift builds only', () => {
    expect(job.strategy.matrix.include).toEqual([
      { language: 'actions', 'build-mode': 'none', os: 'ubuntu-latest' },
      { language: 'javascript-typescript', 'build-mode': 'none', os: 'ubuntu-latest' },
      { language: 'python', 'build-mode': 'none', os: 'ubuntu-latest' },
      { language: 'rust', 'build-mode': 'none', os: 'ubuntu-latest' },
      { language: 'swift', 'build-mode': 'manual', os: 'macos-latest' },
    ]);
    expect(init.with?.['build-mode']).toBe('${{ matrix.build-mode }}');
    expect(steps.some((step) => step.uses?.includes('/autobuild@'))).toBe(false);
  });

  it('resolves locked dependencies before tracing, but compiles after initialization', () => {
    const prepare = named('Resolve Swift dependencies before tracing');
    const build = named('Build the native Swift helper');
    expect(steps.indexOf(prepare)).toBeLessThan(steps.indexOf(init));
    expect(steps.indexOf(build)).toBeGreaterThan(steps.indexOf(init));
    expect(steps.indexOf(build)).toBeLessThan(steps.indexOf(analyze));
    expect(prepare.run).toContain('--disable-automatic-resolution resolve');
    expect(build.run).toContain('--disable-automatic-resolution');
    expect(build.run).toContain('--product voxloom-parakeet-worker');
    expect(build.run).toContain('--arch "$(uname -m)"');
    for (const step of [prepare, build]) expect(step.if).toBe('matrix.language == \'swift\'');
  });

  it('caches downloaded dependencies, never compiled first-party outputs', () => {
    const cache = named('Cache Swift dependency downloads');
    const paths = String(cache.with?.path).trim().split('\n');
    expect(paths).toEqual([
      'src-tauri/parakeet-worker/.build/artifacts',
      'src-tauri/parakeet-worker/.build/checkouts',
      'src-tauri/parakeet-worker/.build/repositories',
    ]);
    expect(cache.with?.key).toContain('Package.resolved');
    expect(steps.indexOf(cache)).toBeLessThan(steps.indexOf(init));
  });

  it('does not upload over default setup until the migration is explicitly enabled', () => {
    expect(analyze.with?.upload).toBe('${{ vars.CODEQL_ADVANCED_SETUP == \'true\' && \'always\' || \'never\' }}');
    expect(analyze.with?.['upload-database']).toBe('${{ vars.CODEQL_ADVANCED_SETUP == \'true\' }}');
    expect(analyze.with?.category).toBe('/language:${{ matrix.language }}');
    expect(named('Verify Swift extraction coverage').run)
      .toBe('node scripts/ci/check-swift-codeql-coverage.mjs codeql-results/swift.sarif');
    expect(steps.indexOf(named('Verify Swift extraction coverage'))).toBeGreaterThan(steps.indexOf(analyze));
    expect(named('Save analysis results').with?.path).toBe('codeql-results/');
  });

  it('keeps PR, main and scheduled scans, caps runtime, and cancels superseded PR runs', () => {
    expect(workflow.on.pull_request).toEqual({ branches: ['main', 'ui/**'] });
    expect(workflow.on.push).toEqual({ branches: ['main'] });
    expect(workflow.on.schedule).toHaveLength(1);
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(job['timeout-minutes']).toBe(30);
    expect(job.strategy['fail-fast']).toBe(false);
    expect(workflow.concurrency['cancel-in-progress']).toBe('${{ github.event_name == \'pull_request\' }}');
  });
});

describe('Swift extraction coverage guard', () => {
  const sources = [
    'Sources/WorkerCore/Wire.swift', 'Sources/WorkerCore/WorkerHost.swift',
    'Sources/WorkerCore/WorkerSession.swift', 'Sources/LocalASR/FluidLocalLoader.swift',
    'Sources/ParakeetWorker/main.swift',
  ].map((path) => `src-tauri/parakeet-worker/${path}`);
  const run = (uris: string[]) => {
    const scratch = mkdtempSync(join(tmpdir(), 'voxloom-codeql-'));
    const sarif = join(scratch, 'swift.sarif');
    writeFileSync(sarif, JSON.stringify({ runs: [{ invocations: [{ toolExecutionNotifications: uris.map((uri) => ({
      descriptor: { id: 'swift/diagnostics/successfully-extracted-files' },
      locations: [{ physicalLocation: { artifactLocation: { uri, uriBaseId: '%SRCROOT%' } } }],
    })) }] }] }));
    return spawnSync('node', [resolve('scripts/ci/check-swift-codeql-coverage.mjs'), sarif], { encoding: 'utf8' });
  };

  it('accepts extraction of every production Swift source', () => {
    const result = run(sources);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('5 production Swift files');
  });

  it('rejects a stale build that skipped a production source', () => {
    const result = run(sources.slice(1));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(sources[0]);
  });

  it('fails closed on an empty extraction report', () => {
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Sources/ParakeetWorker/main.swift');
  });
});

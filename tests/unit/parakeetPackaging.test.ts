import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = process.cwd();

describe('Parakeet release packaging', () => {
  it('checks the Swift helper and universal build in macOS CI without model downloads', () => {
    const workflow = parse(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')) as {
      jobs: Record<string, { 'runs-on': string; steps: { run?: string }[] }>;
    };
    const job = workflow.jobs['parakeet-worker'];
    expect(job).toBeDefined();
    expect(job['runs-on']).toBe('macos-latest');
    const commands = job.steps.map((step) => step.run ?? '').join('\n');
    expect(commands).toContain('swift test --package-path src-tauri/parakeet-worker');
    expect(commands).toContain('bash scripts/release/build-parakeet-worker.sh universal-apple-darwin');
    expect(commands).not.toMatch(/downloadAndLoad|provision.*model|huggingface-cli/);
  });

  it('builds and bundles the transcription helper separately from the main app', () => {
    expect(existsSync(resolve(root, 'scripts/release/build-parakeet-worker.sh'))).toBe(true);
    const config = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.worker.conf.json'), 'utf8')) as {
      bundle: { externalBin: string[]; resources: Record<string, string> };
    };
    expect(config.bundle.externalBin).toContain('binaries/voxloom-parakeet-worker');
    expect(config.bundle.externalBin).toContain('binaries/voxloom-cleanup-worker');
    expect(config.bundle.resources['licenses/parakeet-worker/THIRD-PARTY-NOTICES.txt'])
      .toBe('licenses/parakeet-worker/THIRD-PARTY-NOTICES.txt');
    const build = readFileSync(resolve(root, 'scripts/release/build-macos.sh'), 'utf8');
    expect(build.indexOf('bash scripts/release/build-parakeet-worker.sh "$TARGET"'))
      .toBeGreaterThan(build.indexOf('unset "$var"'));
    expect(build.indexOf('bash scripts/release/build-parakeet-worker.sh "$TARGET"'))
      .toBeLessThan(build.indexOf('npm run tauri'));
    const mainConfig = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8')) as {
      bundle: { macOS: { minimumSystemVersion: string } };
    };
    expect(mainConfig.bundle.macOS.minimumSystemVersion).toBe('13.1');
  });

  it('rejects a packaged app missing the Parakeet helper even when cleanup is valid', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'voxloom-parakeet-package-'));
    try {
      const app = join(scratch, 'Voxloom.app');
      const bin = join(scratch, 'bin');
      mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
      mkdirSync(join(app, 'Contents/Resources/licenses/cleanup-worker'), { recursive: true });
      mkdirSync(bin);
      writeFileSync(join(app, 'Contents/MacOS/voxloom-cleanup-worker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(app, 'Contents/Resources/licenses/cleanup-worker/THIRD-PARTY-NOTICES.txt'), 'fixture notices\n');
      writeFileSync(join(bin, 'lipo'), '#!/bin/sh\nprintf "arm64 x86_64\\n"\n', { mode: 0o755 });
      writeFileSync(join(bin, 'codesign'), '#!/bin/sh\nprintf "CodeDirectory flags=0x10000(runtime)\\nTeamIdentifier=fixture\\n"\n', { mode: 0o755 });
      const result = spawnSync('bash', [resolve(root, 'scripts/release/check-sidecar.sh'), app, 'universal-apple-darwin'], {
        encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Parakeet');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

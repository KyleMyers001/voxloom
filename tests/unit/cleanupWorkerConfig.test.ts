import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('cleanup worker resources', () => {
  it('uses one deterministic packaged and development layout', () => {
    const config = JSON.parse(read('src-tauri/tauri.conf.json')) as {
      bundle: { resources: Record<string, string> };
    };
    expect(config.bundle.resources).toEqual({
      'resources/cleanup/*': 'cleanup/',
    });
    expect(read('src-tauri/src/cleanup/mod.rs')).toContain(
      '.join("cleanup")\n            .join("voxloom-cleanup-worker")',
    );
    expect(read('scripts/build-cleanup-worker.sh')).toContain(
      'src-tauri/resources/cleanup',
    );
  });

  it('runs the committed weight-free protocol smoke after building', () => {
    const build = read('scripts/build-cleanup-worker.sh');
    expect(build).toContain('scripts/smoke-cleanup-worker.py');
    expect(read('scripts/smoke-cleanup-worker.py')).toContain(
      '/definitely/missing/model.gguf',
    );
  });
});

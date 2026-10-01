import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('cleanup worker resources', () => {
  it('keeps the default bundle workerless with its existing platform floor', () => {
    const config = JSON.parse(read('src-tauri/tauri.conf.json')) as {
      bundle: {
        macOS: { minimumSystemVersion: string };
        resources?: Record<string, string>;
      };
    };
    expect(config.bundle.resources ?? {}).toEqual({});
    expect(config.bundle.macOS.minimumSystemVersion).toBe('10.15');
  });

  it('bundles only the executable in the optional macOS 13.3+ build', () => {
    const config = JSON.parse(read('src-tauri/tauri.cleanup.conf.json')) as {
      bundle: {
        macOS: { minimumSystemVersion: string };
        resources: Record<string, string>;
      };
    };
    expect(config.bundle.macOS.minimumSystemVersion).toBe('13.3');
    expect(config.bundle.resources).toEqual({
      'resources/cleanup/voxloom-cleanup-worker':
        'cleanup/voxloom-cleanup-worker',
    });
    expect(read('src-tauri/src/cleanup/mod.rs')).toContain(
      '.join("cleanup")\n            .join("voxloom-cleanup-worker")',
    );
    expect(read('scripts/build-cleanup-worker.sh')).toContain(
      'src-tauri/resources/cleanup',
    );
  });

  it('pins portable arm64 and macOS 13.3 before compiler detection', () => {
    const cmake = read('native/cleanup-worker/CMakeLists.txt');
    expect(cmake).toContain('set(GGML_NATIVE OFF CACHE BOOL "" FORCE)');
    expect(cmake).toContain(
      'set(CMAKE_OSX_ARCHITECTURES "arm64" CACHE STRING "" FORCE)',
    );
    expect(cmake).toContain(
      'set(CMAKE_OSX_DEPLOYMENT_TARGET "13.3" CACHE STRING "" FORCE)',
    );
    expect(cmake.indexOf('CMAKE_OSX_DEPLOYMENT_TARGET'))
      .toBeLessThan(cmake.indexOf('\nproject('));
  });

  it('rejects dirty upstream source and requires opt-in to replace a worker', () => {
    const build = read('scripts/build-cleanup-worker.sh');
    expect(build).toContain('status --porcelain --untracked-files=all');
    expect(build).toContain('VOXLOOM_CLEANUP_REPLACE_WORKER');
  });

  it('wires tested safety boundaries without reflecting private exceptions', () => {
    const main = read('native/cleanup-worker/main.cpp');
    const framing = read('native/cleanup-worker/framing.hpp');
    expect(main).not.toContain('error.what()');
    expect(main).toContain('voxloom::silence_stderr()');
    expect(main).toContain('voxloom::require_model(model_path)');
    expect(framing).toContain('validate_output(');
    expect(framing).not.toContain('error_handler_t::replace');
    expect(read('scripts/build-cleanup-worker.sh')).toContain('voxloom-safety-check');
  });

  it('checks actual GGUF metadata through the generation renderer, separately from weight-free smoke', () => {
    const main = read('native/cleanup-worker/main.cpp');
    const check = read('native/cleanup-worker/template_check.cpp');
    expect(main).toContain('voxloom::render_prompt(');
    expect(check).toContain('voxloom::render_prompt(');
    expect(check).toContain('--model');
    expect(check).toContain('vocab_only = true');
    expect(read('scripts/check-cleanup-template.py')).toContain('verified_model(');
    expect(read('scripts/build-cleanup-worker.sh')).not.toContain('check-cleanup-template.py');
  });

  it('runs the committed weight-free protocol smoke after building', () => {
    const build = read('scripts/build-cleanup-worker.sh');
    expect(build).toContain('scripts/smoke-cleanup-worker.py');
    expect(read('scripts/smoke-cleanup-worker.py')).toContain(
      '/definitely/missing/model.gguf',
    );
  });
});

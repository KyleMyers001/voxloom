import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

describe('native CI coverage', () => {
  it('checks and repeatedly tests default/Whisper on macOS without weights', () => {
    const nativeJob = workflow.split('  native-macos:')[1];
    expect(nativeJob).toBeDefined();
    expect(nativeJob).toMatch(/runs-on: macos-/);
    expect(nativeJob).toContain('cargo check --manifest-path src-tauri/Cargo.toml --locked');
    expect(nativeJob).toContain('cargo check --manifest-path src-tauri/Cargo.toml --locked --features whisper');
    expect(nativeJob).toContain('for run in 1 2 3 4 5');
    expect(nativeJob).toContain('cargo test --manifest-path src-tauri/Cargo.toml --locked --lib');
    expect(nativeJob).toContain('cargo test --manifest-path src-tauri/Cargo.toml --locked --lib --features whisper');
    expect(nativeJob).not.toContain('--test-threads');
    expect(nativeJob).not.toContain('continue-on-error');
    expect(nativeJob).not.toContain('build-cleanup-worker');
  });
});

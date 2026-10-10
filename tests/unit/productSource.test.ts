import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function rustSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? rustSources(path) : entry.name.endsWith('.rs') ? [path] : [];
  });
}

describe('distributable native source', () => {
  it('excludes temporary focus and terminal transport instrumentation', () => {
    const files = [resolve(root, 'src-tauri/Cargo.toml'), ...rustSources(resolve(root, 'src-tauri/src'))];
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(
        /focus_diagnostic|focus-diagnostic|terminal_probe|terminal-transport-diagnostic|voxloom-inprocess-probe/,
      );
    }
  });

  it('keeps completion observation synchronous and bootstrap out of focus guards', () => {
    const focus = readFileSync(resolve(root, 'src-tauri/src/delivery/macos/focus.rs'), 'utf8');
    const commands = readFileSync(resolve(root, 'src-tauri/src/delivery/mod.rs'), 'utf8');
    expect(commands).toMatch(/pub fn delivery_snapshot_target\(/);
    // Validation/insert/per-chunk guards must not wait for WEB_AX or bootstrap.
    const guard = focus.split('pub fn focused_ui_element(')[1].split('\n}')[0];
    expect(guard).toContain('focused_ui_element_once(stage)');
    expect(guard).not.toMatch(/warm_web_ax|WEB_AX|sleep|lock\(/);
    const snapshot = focus.split('pub fn snapshot_at(')[1].split('\nfn snapshot_from_focus')[0];
    const observation = snapshot.indexOf('snapshot_from_focus(focused_ui_element_once(stage), true)');
    const scheduling = snapshot.indexOf('completion_snapshot_with(initial, move ||');
    expect(observation).toBeGreaterThan(-1);
    expect(scheduling).toBeGreaterThan(observation);
    const worker = snapshot.slice(scheduling, snapshot.indexOf('\n        });', scheduling));
    expect(worker).toContain('warm_web_ax(&stage, front)');
    expect(worker).toContain('release(element as CFTypeRef)');
    expect(worker).not.toMatch(/build_snapshot|snapshot_from_focus|registry::/);
    expect(focus.split('#[cfg(test)]')[0]).not.toContain('WEB_AX.lock()');
  });

  it('has no developer-home or scratch-dependent native source', () => {
    for (const file of rustSources(resolve(root, 'src-tauri/src'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\/Users\/|\/\.hermes\/|include_bytes!\s*\(\s*"\//);
    }
  });
});

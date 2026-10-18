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

  it('re-asserts web AX per attempt and keeps the bounded wait out of focus guards', () => {
    const focus = readFileSync(resolve(root, 'src-tauri/src/delivery/macos/focus.rs'), 'utf8');
    const webAx = readFileSync(resolve(root, 'src-tauri/src/delivery/macos/web_ax.rs'), 'utf8');
    const commands = readFileSync(resolve(root, 'src-tauri/src/delivery/mod.rs'), 'utf8');
    // The bounded wait must never block the UI thread.
    expect(commands).toMatch(/#\[tauri::command\(async\)\]\npub fn delivery_snapshot_target\(/);
    // Validation/insert/per-chunk guards must not wait or re-assert.
    const guard = focus.split('pub fn focused_ui_element(')[1].split('\n}')[0];
    expect(guard).toContain('focused_ui_element_once(stage)');
    expect(guard).not.toMatch(/web_ax|WEB_AX|sleep|lock\(/);
    // Completion: re-assert (no per-pid cache), then same-pid bounded settle.
    const snapshot = focus.split('pub fn snapshot_at(')[1].split('\nfn snapshot_from_focus')[0];
    const reassert = snapshot.indexOf('web_ax::reassert(front)');
    const settle = snapshot.indexOf('web_ax::settle_focus(stage, front, focused_ui_element_once(stage))');
    expect(reassert).toBeGreaterThan(-1);
    expect(settle).toBeGreaterThan(reassert);
    expect(focus + webAx).not.toMatch(/WEB_AX|static .*Mutex/);
    expect(webAx).toContain('frontmost_pid');
  });

  it('has no developer-home or scratch-dependent native source', () => {
    for (const file of rustSources(resolve(root, 'src-tauri/src'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\/Users\/|\/\.hermes\/|include_bytes!\s*\(\s*"\//);
    }
  });
});

/**
 * BUS-47: every window that emits events needs core:event:allow-emit in its
 * capability file, or Tauri refuses the emit. Tauri 2 can't scope emit to an
 * event name, so the plain permission is asserted.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Capability { windows: string[]; permissions: (string | { identifier: string })[] }

const load = (name: string): Capability =>
  JSON.parse(readFileSync(resolve(__dirname, '../../src-tauri/capabilities', `${name}.json`), 'utf8'));

const ids = (c: Capability) => c.permissions.map((p) => (typeof p === 'string' ? p : p.identifier));

describe('window capabilities', () => {
  it.each([
    ['settings', 'settings'], // queryShortcutBound emits shortcut:query
    ['main', 'main'], // shortcut:bound, overlay:waveform
  ])('%s capability lets the %s window emit and listen', (file, window) => {
    const cap = load(file);
    expect(cap.windows).toContain(window);
    expect(ids(cap)).toEqual(expect.arrayContaining(['core:event:allow-emit', 'core:event:allow-listen']));
  });
});

describe('privacy pane command', () => {
  it('is granted to the main window only', () => {
    expect(ids(load('main'))).toContain('allow-privacy-pane-open');
    for (const other of ['settings', 'overlay']) {
      expect(ids(load(other))).not.toContain('allow-privacy-pane-open');
    }
  });
});

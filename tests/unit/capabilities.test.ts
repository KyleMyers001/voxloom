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

describe('cleanup model import is gone (BUS-186)', () => {
  it.each(['settings', 'main'])('%s capability no longer allows the import command', (file) => {
    expect(ids(load(file))).not.toContain('allow-cleanup-pick-and-import-model');
    expect(ids(load(file))).toContain('allow-cleanup-download-model');
  });
});

// BUS-209: Voxloom's key taps run on Accessibility, never Input Monitoring.
// The taps are macOS-only native code, so their shape is pinned here.
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const LONE_KEY = 'src-tauri/src/lone_key/macos.rs';
const HOLD = 'src-tauri/src/hold_release.rs';
const TAP_THREAD = 'src-tauri/src/tap_thread.rs';

/** Source without comments or whitespace, so checks ignore formatting. */
const code = (source: string) => source.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '');

function rustSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? rustSources(path) : entry.name.endsWith('.rs') ? [path] : [];
  });
}

/** The body of `unsafe extern "C" fn <name>(...)`, up to its closing brace. */
function callbackBody(source: string, name: string): string {
  const start = source.indexOf(`unsafe extern "C" fn ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const open = source.indexOf('{', source.indexOf('->', start));
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unterminated ${name}`);
}

describe('accessibility-only key taps', () => {
  it('creates both taps with the default (active) option', () => {
    expect(read('src-tauri/src/lone_key/tap_ffi.rs')).toContain('pub(super) const TAP_DEFAULT: u32 = 0;');
    expect(read(HOLD)).toContain('const TAP_DEFAULT: u32 = 0;');
    for (const file of [LONE_KEY, HOLD]) {
      const source = read(file);
      expect(source, file).toMatch(/CGEventTapCreate\(\s*TAP_SESSION,\s*TAP_HEAD,\s*TAP_DEFAULT,/);
      expect(source, file).not.toContain('TAP_LISTEN_ONLY');
    }
  });

  it('passes every event through unchanged', () => {
    for (const [file, name] of [[LONE_KEY, 'callback'], [HOLD, 'tap_callback']]) {
      const body = callbackBody(read(file), name);
      const returns = body.match(/return [^;]+;/g) ?? [];
      expect(returns.length, file).toBeGreaterThan(0);
      for (const ret of returns) expect(ret, file).toBe('return event;');
      expect(body.trimEnd().endsWith('event'), file).toBe(true);
      expect(body, file).not.toMatch(/null_mut\(\)/);
    }
    // Not in the callback, nor in any helper it could call.
    for (const file of [LONE_KEY, HOLD, 'src-tauri/src/lone_key/context.rs', TAP_THREAD]) {
      expect(read(file), file).not.toMatch(/CGEventSet|CGEventCreate|CGEventPost/);
    }
  });

  it('runs both taps on their own thread, never the main run loop', () => {
    for (const file of [LONE_KEY, HOLD]) {
      const source = code(read(file));
      expect(source, file).toContain('tap_thread::spawn(');
      expect(source, file).toContain('tap_thread::run_until_stopped(&stopping)');
      expect(source, file).toContain('CFRunLoopAddSource(CFRunLoopGetCurrent(),');
      expect(source, file).not.toContain('CFRunLoopAddSource(CFRunLoopGetMain()');
      expect(source, file).toContain('.stop(RunLoop::stop)');
    }
    // The debounce wake-up stays on the tap thread too.
    const context = code(read('src-tauri/src/lone_key/context.rs'));
    expect(context).toContain('CFRunLoopAddTimer(CFRunLoopGetCurrent(),');
    expect(context).not.toContain('run_on_main_thread');
  });

  it('never asks for or depends on Input Monitoring', () => {
    for (const path of rustSources(resolve(root, 'src-tauri/src'))) {
      const file = relative(root, path);
      const source = readFileSync(path, 'utf8');
      expect(source, file).not.toMatch(/CGRequestListenEventAccess|IOHIDRequestAccess|IOHIDCheckAccess/);
      // Esc-cancel diagnostics may still log it as evidence; nothing gates on it.
      if (file !== 'src-tauri/src/cancel_scope/macos.rs') {
        expect(source, file).not.toContain('CGPreflightListenEventAccess');
      }
    }
  });

  it('gates the lone key on Accessibility and prompts only from request_access', () => {
    const source = read(LONE_KEY);
    const arm = source.slice(source.indexOf('pub fn arm('), source.indexOf('pub fn disarm('));
    expect(arm.indexOf('if !accessibility_trusted()')).toBeGreaterThan(-1);
    expect(arm.indexOf('if !accessibility_trusted()')).toBeLessThan(arm.indexOf('tap_thread::spawn('));
    expect(arm).not.toContain('prompt_for_accessibility');
    expect(source).toContain('request_if_needed(accessibility_trusted, prompt_for_accessibility)');
    expect(source.match(/AXIsProcessTrustedWithOptions\(/g)).toHaveLength(1);
  });

  it('checks Accessibility before the hold tap and never prompts there', () => {
    const source = read(HOLD);
    const watch = code(source.slice(source.indexOf('fn start_watch('), source.indexOf('fn disarm_inner(')));
    expect(watch).toContain('tap_if_trusted(||unsafe{AXIsProcessTrusted()!=0},||try_install_tap(');
    expect(source).not.toContain('AXIsProcessTrustedWithOptions');
  });
});

// BUS-209: Voxloom's key taps run on Accessibility, never Input Monitoring.
// The taps are macOS-only native code, so their shape is pinned here.
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const LONE_KEY = 'src-tauri/src/lone_key/macos.rs';
const HOLD = 'src-tauri/src/hold_release.rs';
const TAP_THREAD = 'src-tauri/src/tap_thread/mod.rs';
const ACCESS = 'src-tauri/src/lone_key/access.rs';
const ESC = 'src-tauri/src/cancel_scope/macos.rs';

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
      expect(source, file).toContain('tap_thread::run_until_stopped(&stopping,');
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
      if (file !== ESC && file !== 'src-tauri/src/cancel_scope/ffi.rs') {
        expect(source, file).not.toContain('CGPreflightListenEventAccess');
      }
    }
  });

  it('gates the lone key on Accessibility and prompts only from request_access', () => {
    const source = read(LONE_KEY);
    const arm = source.slice(source.indexOf('pub fn arm('), source.indexOf('pub fn disarm('));
    const gate = 'if !super::access::accessibility_trusted()';
    expect(arm.indexOf(gate)).toBeGreaterThan(-1);
    expect(arm.indexOf(gate)).toBeLessThan(arm.indexOf('tap_thread::spawn('));
    expect(arm).not.toContain('prompt_for_accessibility');
    const access = read(ACCESS);
    expect(access).toContain('request_if_needed(accessibility_trusted, prompt_for_accessibility)');
    expect(access.match(/AXIsProcessTrustedWithOptions\(/g)).toHaveLength(1);
    expect(source).not.toContain('AXIsProcessTrustedWithOptions(');
  });

  it('never re-enables a tap from its callback; the watchdog decides', () => {
    for (const [file, name] of [[LONE_KEY, 'callback'], [HOLD, 'tap_callback'], [ESC, 'callback']]) {
      const body = code(callbackBody(read(file), name));
      expect(body, file).not.toContain('CGEventTapEnable');
      expect(body, file).not.toContain('still_trusted');
    }
    for (const file of [LONE_KEY, HOLD]) {
      const source = code(read(file));
      expect(source, file).toContain('tap_thread::wake_current()');
      expect(source, file).toContain('guard.check(');
      expect(source, file).toContain('tap_guard::watch_access()');
      expect(source, file).toContain('access.trusted(),Instant::now())');
    }
  });

  it('runs the blocking probe only on the checker thread', () => {
    // CR a8b75bd item 2: a thread that services a tap (main, for Esc) only
    // reads the published flag; it never waits on the window server.
    for (const path of rustSources(resolve(root, 'src-tauri/src'))) {
      const file = relative(root, path);
      if (file.startsWith('src-tauri/src/tap_guard/')) continue;
      expect(readFileSync(path, 'utf8'), file).not.toContain('still_trusted');
    }
    const guard = code(read('src-tauri/src/tap_guard/mod.rs'));
    expect(guard).toContain('Monitor::new(probe::still_trusted,CHECK_INTERVAL)');
    const monitor = code(read('src-tauri/src/tap_guard/monitor.rs'));
    expect(monitor).toContain('.name("tap-access-check".into()).spawn(move||run(inner))');
    // A result applies only to watches no newer than the check (BUS-209).
    expect(monitor).toContain('inner.epoch.load(Ordering::SeqCst)};if!(inner.check)(){inner.mark_lost(epoch);}');
    expect(monitor).toContain('self.inner.lost_through.load(Ordering::SeqCst)<self.epoch');
  });

  it('probes Accessibility with an active tap, not AXIsProcessTrusted alone', () => {
    const probe = code(read('src-tauri/src/tap_guard/probe.rs'));
    expect(probe).toContain('ifAXIsProcessTrusted()==0{returnfalse;}');
    expect(probe).toContain('CGEventTapCreate(TAP_SESSION,TAP_TAIL,TAP_DEFAULT,MASK_NULL,');
    expect(probe).toContain('constTAP_DEFAULT:u32=0;');
    expect(probe).toContain('CFMachPortInvalidate(probe);CFRelease(probe);');
  });

  it('watches the Escape tap while armed and closes every tap on quit', () => {
    const esc = code(read(ESC));
    expect(esc).toContain('Watch::start(on_watch)');
    expect(esc).toContain('fnon_watch(_timer:Handle,_info:Handle){letlost=ACTIVE.with(');
    expect(esc).toContain('.is_some_and(AccessWatch::trusted)');
    expect(esc).toContain('tap.access=Some(crate::tap_guard::watch_access()?);');
    const lib = code(read('src-tauri/src/lib.rs'));
    expect(lib).toContain('iflettauri::RunEvent::Exit=event{close_taps();}');
    const close = lib.slice(lib.indexOf('fnclose_taps()'));
    for (const call of ['cancel_scope::close()', 'lone_key_disarm()', 'hold_release_disarm()']) {
      expect(close).toContain(call);
    }
  });

  it('checks Accessibility before the hold tap and never prompts there', () => {
    const source = read(HOLD);
    const watch = code(source.slice(source.indexOf('fn start_watch('), source.indexOf('fn disarm_inner(')));
    expect(watch).toContain('tap_if_trusted(||unsafe{AXIsProcessTrusted()!=0},||try_install_tap(');
    expect(source).not.toContain('AXIsProcessTrustedWithOptions');
  });
});

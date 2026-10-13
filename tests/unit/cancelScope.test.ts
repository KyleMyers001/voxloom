import { readFileSync } from 'node:fs';
import { beginCancelScope } from '../../src/services/shortcut/cancelScope';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(), listen: vi.fn(), unlisten: vi.fn(), handler: null as null | ((event: { payload: string }) => void),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: ipc.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: ipc.listen }));

beforeEach(() => {
  vi.clearAllMocks();
  ipc.invoke.mockResolvedValue(true);
  ipc.listen.mockImplementation(async (_name, callback) => { ipc.handler = callback; return ipc.unlisten; });
});

describe('native cancellation scope', () => {
  it('listens before arming and ignores stale sessions; finish is a native delivery barrier', async () => {
    const cancel = vi.fn();
    const scope = await beginCancelScope(cancel);
    expect(ipc.listen.mock.invocationCallOrder[0]).toBeLessThan(ipc.invoke.mock.invocationCallOrder[0]);
    const id = ipc.invoke.mock.calls[0][1].session;
    expect(ipc.invoke).toHaveBeenCalledWith('dictation_cancel_arm', { session: id });
    ipc.handler?.({ payload: 'old-session' });
    expect(cancel).not.toHaveBeenCalled();
    ipc.handler?.({ payload: id });
    expect(cancel).toHaveBeenCalledOnce();
    ipc.invoke.mockResolvedValue(false);
    expect(await scope.finish()).toBe(false);
    expect(ipc.invoke).toHaveBeenLastCalledWith('dictation_cancel_finish', { session: id });
    expect(ipc.unlisten).toHaveBeenCalledOnce();
    await scope.dispose();
    expect(ipc.unlisten).toHaveBeenCalledOnce();
  });

  it('cleans listener on arm failure and does not leave a native scope on dispose', async () => {
    ipc.invoke.mockRejectedValueOnce(new Error('tap denied'));
    await expect(beginCancelScope(vi.fn())).rejects.toThrow('tap denied');
    expect(ipc.unlisten).toHaveBeenCalledOnce();
    ipc.unlisten.mockClear();
    const scope = await beginCancelScope(vi.fn());
    const id = ipc.invoke.mock.calls.at(-1)?.[1].session;
    await scope.dispose();
    expect(ipc.invoke).toHaveBeenLastCalledWith('dictation_cancel_end', { session: id });
    expect(ipc.unlisten).toHaveBeenCalledOnce();
  });

  it('tries native teardown when the delivery barrier rejects', async () => {
    const scope = await beginCancelScope(vi.fn());
    const id = ipc.invoke.mock.calls[0][1].session;
    ipc.invoke.mockRejectedValueOnce(new Error('barrier IPC failed'));
    await expect(scope.finish()).rejects.toThrow('barrier IPC failed');
    expect(ipc.invoke).toHaveBeenLastCalledWith('dictation_cancel_end', { session: id });
    expect(ipc.unlisten).toHaveBeenCalledOnce();
  });

  it('keeps tap-failure evidence non-prompting and the active tap fail-closed', () => {
    const native = readFileSync('src-tauri/src/cancel_scope/macos.rs', 'utf8');
    expect(native).toContain('CGEventTapCreate(1, 0, 0, 1 << 10, callback, context.cast())');
    const failure = native.slice(native.indexOf('if port.is_null()'), native.indexOf('let source = CFMachPortCreateRunLoopSource'));
    for (const call of ['AXIsProcessTrusted() != 0', 'CGPreflightListenEventAccess()', 'CGPreflightPostEventAccess()']) {
      expect(failure).toContain(call);
    }
    expect(failure).toContain('return Err(super::diagnostics::tap_failure_message(');
    expect(failure).toContain('let context = Box::from_raw(context)');
    expect(native).not.toMatch(/CGRequest(?:Listen|Post)EventAccess\(|AXIsProcessTrustedWithOptions\(/);
    expect(native).not.toContain('Enable Voxloom Accessibility permission');
    expect(native).toContain('let tap = Tap::install(app, session)?;');
  });

  it('wires native scope and main-window cleanup into the shipped app', () => {
    const lib = readFileSync('src-tauri/src/lib.rs', 'utf8');
    expect(lib).toContain('cancel_scope::dictation_cancel_arm');
    expect(lib).toContain('cancel_scope::dictation_cancel_finish');
    expect(lib).toContain('cancel_scope::dictation_cancel_end');
    expect(lib).toContain('cancel_scope::close');
    const overlay = readFileSync('src-tauri/src/overlay.rs', 'utf8');
    expect(overlay).toContain('cancellable && !crate::cancel_scope::can_show()');
    expect(overlay).toContain('crate::cancel_scope::visible(cancellable)');
  });
});

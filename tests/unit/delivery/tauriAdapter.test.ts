import { describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a), isTauri: () => true }));

const { createTauriDeliveryAdapter } = await import('../../../src/services/delivery/tauriAdapter');
const { InsertError } = await import('../../../src/services/delivery/types');

const clipboard = { readText: vi.fn(), writeText: vi.fn() } as never;
const target = {} as never;

describe('tauri insertText errors', () => {
  it('a native Err string means nothing was written', async () => {
    invoke.mockRejectedValueOnce('AXValue unreadable before insert — insert skipped');
    const error = await createTauriDeliveryAdapter(clipboard).insertText('hi', target).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InsertError);
    expect((error as InstanceType<typeof InsertError>).writeStarted).toBe(false);
  });

  it('any other failure may have hit mid-write', async () => {
    invoke.mockRejectedValueOnce(new Error('IPC channel closed'));
    const error = await createTauriDeliveryAdapter(clipboard).insertText('hi', target).catch((e: unknown) => e);
    expect((error as InstanceType<typeof InsertError>).writeStarted).toBe(true);
  });
});

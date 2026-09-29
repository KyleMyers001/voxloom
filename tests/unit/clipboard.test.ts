import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: vi.fn(() => false),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}));

import { isTauri } from '@tauri-apps/api/core';
import { writeText as tauriWriteText } from
  '@tauri-apps/plugin-clipboard-manager';
import {
  createClipboardAdapter,
  resolveClipboardWrite,
} from '../../src/services/clipboard';

describe('createClipboardAdapter', () => {
  beforeEach(() => {
    vi.mocked(isTauri).mockReturnValue(false);
    vi.mocked(tauriWriteText).mockClear();
  });

  it('writes only when copy is explicitly called (browser fallback)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const clipboard = createClipboardAdapter();
    expect(writeText).not.toHaveBeenCalled();
    await clipboard.copy('synthetic text');
    expect(writeText).toHaveBeenCalledWith('synthetic text');
    expect(tauriWriteText).not.toHaveBeenCalled();
  });

  it('uses Tauri native write when isTauri() is true', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const clipboard = createClipboardAdapter();
    await clipboard.copy('native text');
    expect(tauriWriteText).toHaveBeenCalledWith('native text');
  });

  it('honors injected write override (mockable Tauri path)', async () => {
    const injected = vi.fn().mockResolvedValue(undefined);
    const clipboard = createClipboardAdapter(() => false, injected);
    await clipboard.copy('injected');
    expect(injected).toHaveBeenCalledWith('injected');
    expect(tauriWriteText).not.toHaveBeenCalled();
  });

  it('surfaces injected failure', async () => {
    await expect(createClipboardAdapter(() => true).copy('text'))
      .rejects.toThrow('Simulated clipboard failure');
  });

  it('resolveClipboardWrite prefers inject then Tauri then browser', () => {
    const injected = vi.fn();
    expect(resolveClipboardWrite(injected)).toBe(injected);

    vi.mocked(isTauri).mockReturnValue(true);
    expect(resolveClipboardWrite()).not.toBe(injected);
  });
});

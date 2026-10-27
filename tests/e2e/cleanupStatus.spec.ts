import { expect, test } from '@playwright/test';

/**
 * BUS-16 PR 3a (Codex 4315232707): the Settings window under a mocked Tauri
 * bridge. The first cleanup_model_status rejects; the block shows the error
 * and Check again, and Check again recovers. This runs on the vite dev server
 * (DEV), where the block always shows; production keeps it hidden after a
 * failed read until PR 3c ships a worker (vitest covers that gate).
 */
test('cleanup: a failed first status check offers Check again, which recovers', async ({ page }) => {
  let statusCalls = 0;
  await page.exposeFunction('__e2eInvoke', (cmd: string) => {
    if (cmd === 'cleanup_model_status') {
      statusCalls += 1;
      if (statusCalls === 1) throw { code: 'runtime-error', message: 'model status task failed' };
      return {
        available: true, id: 'qwen3-0.6b-q4-k-m', runtimeAvailable: true,
        sha256: 'ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a',
      };
    }
    if (/list|devices/.test(cmd)) return [];
    if (cmd.startsWith('plugin:event|listen')) return 1;
    return null;
  });
  await page.addInitScript(() => {
    type Win = Window & Record<string, unknown> & { __e2eInvoke: (cmd: string) => Promise<unknown> };
    const w = window as unknown as Win;
    let callback = 1;
    w.isTauri = true;
    w.__TAURI_INTERNALS__ = {
      convertFileSrc: (path: string) => path,
      invoke: (cmd: string) => w.__e2eInvoke(cmd),
      metadata: { currentWebview: { label: 'settings', windowLabel: 'settings' }, currentWindow: { label: 'settings' } },
      transformCallback: (cb: unknown) => { const id = callback++; w[`_${id}`] = cb; return id; },
      unregisterCallback: () => {},
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  await page.goto('/settings.html');
  await page.getByRole('tab', { name: /^Capture/ }).click();
  const note = page.locator('#settings-cleanup-model-note');
  await expect(note).toHaveText('Couldn\'t check the cleanup model: model status task failed.');
  await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(note).toHaveText('Qwen3 0.6B is installed.');
  expect(statusCalls).toBe(2);
});

import { expect, it, vi } from 'vitest';
import { createSetupBoundary } from '../../src/features/onboarding/setupBoundary';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => true }));
it('queries without requests and sends explicit permission/settings and model IDs to native adapters', async () => {
  invoke.mockResolvedValue({ microphone: 'denied', accessibility: 'not-granted', inputMonitoring: 'not-granted' });
  const io = createSetupBoundary();
  expect((await io.query()).accessibility).toBe('not-granted');
  expect(invoke.mock.calls).toEqual([['setup_query_permissions']]);
  await io.request('input-monitoring');
  expect(invoke).toHaveBeenLastCalledWith('setup_request_permission', { kind: 'input-monitoring' });
  await io.openSettings('accessibility');
  expect(invoke).toHaveBeenLastCalledWith('setup_open_permission_settings', { kind: 'accessibility' });
  await io.readiness('whisper-base.en');
  expect(invoke).toHaveBeenLastCalledWith('setup_model_readiness', { modelId: 'whisper-base.en' });
});

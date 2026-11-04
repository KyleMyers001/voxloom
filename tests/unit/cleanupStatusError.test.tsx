// BUS-16 PR 3a: a failed first status read shows the Local cleanup error
// block only where the block is already shown (dev builds; worker-bundled
// builds from PR 3c), and an import failure is never shown as a check failure
// (BUS-112 item 4). Each describe stubs DEV to pick the build.
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApp } from '../../src/app/AppContext';
import { initialSettings } from '../../src/domain/fixtures';
import type { Settings } from '../../src/domain/types';
import { CleanupSettings } from '../../src/features/settings/CleanupSettings';
import { useCleanupModel } from '../../src/features/settings/useCleanupModel';
import type { CleanupModelStore } from '../../src/services/cleanup/contracts';
import { CLEANUP_MODEL_ID, CLEANUP_MODEL_SHA256, type CleanupModelStatus } from '../../src/services/cleanup/types';
import { renderWithApp } from './testUtils';

const ready: CleanupModelStatus = {
  available: true, id: CLEANUP_MODEL_ID, runtimeAvailable: true, sha256: CLEANUP_MODEL_SHA256,
};

function Harness({ modelStore, start }: { modelStore: CleanupModelStore; start?: Partial<Settings> }) {
  const { dispatch } = useApp();
  useEffect(() => {
    if (start) dispatch({ onboardingComplete: true, settings: { ...initialSettings, ...start }, type: 'hydrate-settings' });
  }, [dispatch, start]);
  return <CleanupSettings isNative model={useCleanupModel(true, modelStore)} />;
}

const note = () => document.getElementById('settings-cleanup-model-note')?.textContent;
const button = (name: string) => screen.getByRole('button', { name });

afterEach(() => { vi.unstubAllEnvs(); });

describe('first status read fails in a production build', () => {
  beforeEach(() => { vi.stubEnv('DEV', false); });

  it('keeps the block hidden: no build bundles a worker before PR 3c', async () => {
    const status = vi.fn().mockRejectedValue(new Error('denied'));
    const { container } = renderWithApp(<Harness modelStore={{ status }} />);
    await waitFor(() => expect(status).toHaveBeenCalledOnce());
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });
});

describe('first status read fails in a dev build (Codex 4315232707)', () => {
  beforeEach(() => { vi.stubEnv('DEV', true); });

  it('Check again keeps the error block and focus while it checks, then recovers', async () => {
    const user = userEvent.setup();
    let answer!: (status: CleanupModelStatus) => void;
    const status = vi.fn()
      .mockRejectedValueOnce(new Error('denied'))
      .mockImplementationOnce(() => new Promise<CleanupModelStatus>((resolve) => { answer = resolve; }));
    renderWithApp(<Harness modelStore={{ status }} />);
    await waitFor(() => expect(note()).toBe('Couldn\'t check the cleanup model: denied.'));
    const checkAgain = button('Check again');
    await user.click(checkAgain);
    expect(note()).toBe('Checking the cleanup model…');
    expect(screen.getByText('Local cleanup')).toBeInTheDocument();
    expect(button('Check again')).toBe(checkAgain);
    expect(checkAgain).toHaveFocus();
    await act(async () => { answer(ready); });
    expect(note()).toBe('Qwen3 0.6B is installed.');
    expect(checkAgain).toHaveFocus();
    expect(status).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('switch', { name: 'Clean up transcripts locally' })).toBeEnabled();
  });
});

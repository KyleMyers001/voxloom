import { act, fireEvent, render, screen, waitFor } from
  '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CleanupSettings } from
  '../../src/features/settings/CleanupSettings';
import {
  CLEANUP_MODEL_ID,
  type CleanupModelStatus,
  type CleanupModelStore,
} from '../../src/services/cleanup';

const installed: CleanupModelStatus = {
  available: true,
  id: CLEANUP_MODEL_ID,
  runtimeAvailable: true,
  sha256: 'digest',
};
const missing = { ...installed, available: false };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, reject, resolve };
}

function setup(
  modelStore: CleanupModelStore,
  options: { enabled?: boolean; isNative?: boolean; modelId?: string } = {},
) {
  const onEnabledChange = vi.fn();
  const onModelChange = vi.fn();
  function Settings() {
    const [enabled, setEnabled] = useState(options.enabled ?? false);
    const [modelId, setModelId] = useState<string | null>(
      options.modelId ?? null,
    );
    return <CleanupSettings
      enabled={enabled}
      isNative={options.isNative ?? true}
      modelId={modelId}
      modelStore={modelStore}
      onEnabledChange={(value) => {
        onEnabledChange(value);
        setEnabled(value);
      }}
      onModelChange={(value) => {
        onModelChange(value);
        setModelId(value);
      }}
    />;
  }
  return {
    ...render(<Settings />),
    onEnabledChange,
    onModelChange,
    toggle: screen.getByLabelText(
      /Clean transcripts with the imported local model/,
    ),
    user: userEvent.setup(),
  };
}

function importButton() {
  return screen.getByLabelText(/Language-processing model import/);
}

function refreshButton() {
  return screen.getByRole('button', { name: /Refresh cleanup status/ });
}

describe('CleanupSettings', () => {
  it('refreshes after import, selects the model, but never opts in', async () => {
    const modelStore = {
      importModel: vi.fn().mockResolvedValue(installed),
      status: vi.fn().mockResolvedValueOnce(missing)
        .mockResolvedValue(installed),
    };
    const { onEnabledChange, onModelChange, toggle, user } = setup(modelStore);
    expect(toggle).toBeDisabled();
    await user.click(importButton());
    expect(modelStore.importModel).toHaveBeenCalledOnce();
    expect(modelStore.status).toHaveBeenCalledTimes(2);
    expect(toggle).toBeEnabled();
    expect(toggle).not.toBeChecked();
    expect(onModelChange).toHaveBeenCalledWith(installed.id);
    expect(onEnabledChange).not.toHaveBeenCalled();
    await user.click(toggle);
    expect(onEnabledChange).toHaveBeenCalledWith(true);
  });

  it.each([
    ['missing worker', { ...installed, runtimeAvailable: false }],
    ['missing model', missing],
    ['status query failure', null],
  ])('allows disabling with %s', async (_name, status) => {
    const modelStore = {
      importModel: vi.fn(),
      status: status
        ? vi.fn().mockResolvedValue(status)
        : vi.fn().mockRejectedValue(new Error('status unavailable')),
    };
    const { onEnabledChange, toggle, user } = setup(modelStore, {
      enabled: true,
      modelId: installed.id,
    });
    await act(async () => {});
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
    await user.click(toggle);
    expect(onEnabledChange).toHaveBeenCalledWith(false);
    expect(toggle).toBeDisabled();
  });

  it('explains why reimport cannot repair an unavailable worker', async () => {
    const status = { ...installed, runtimeAvailable: false };
    const { toggle, user } = setup({
      importModel: vi.fn().mockResolvedValue(status),
      status: vi.fn().mockResolvedValue(status),
    });
    await user.click(importButton());
    expect(screen.getByText(/is installed locally/)).toBeInTheDocument();
    expect(screen.getByText(/Reimporting.*will not fix/i)).toBeInTheDocument();
    expect(toggle).toBeDisabled();
  });

  it.each(['cancelled', 'invalid'])('refreshes after %s import', async (kind) => {
    const modelStore = {
      importModel: kind === 'cancelled'
        ? vi.fn().mockResolvedValue(null)
        : vi.fn().mockRejectedValue(new Error('SHA-256 mismatch')),
      status: vi.fn().mockResolvedValue(missing),
    };
    const { onEnabledChange, onModelChange, toggle, user } = setup(modelStore);
    await user.click(importButton());
    expect(modelStore.status).toHaveBeenCalledTimes(2);
    expect(toggle).toBeDisabled();
    expect(onEnabledChange).not.toHaveBeenCalled();
    expect(onModelChange).not.toHaveBeenCalled();
    if (kind === 'invalid') {
      expect(screen.getByRole('alert')).toHaveTextContent('SHA-256 mismatch');
    } else {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    }
  });

  it.each(['response', 'error'])('ignores an old status %s after import', async (kind) => {
    const old = deferred<CleanupModelStatus>();
    const modelStore = {
      importModel: vi.fn().mockResolvedValue(installed),
      status: vi.fn().mockReturnValueOnce(old.promise)
        .mockResolvedValue(installed),
    };
    const { toggle, user } = setup(modelStore);
    await user.click(importButton());
    await act(async () => {
      if (kind === 'response') old.resolve(missing);
      else old.reject(new Error('stale status error'));
    });
    expect(toggle).toBeEnabled();
    expect(screen.getByText(/is installed locally/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('uses latest-request-wins for focus and explicit refresh', async () => {
    const older = deferred<CleanupModelStatus>();
    const modelStore = {
      importModel: vi.fn(),
      status: vi.fn().mockResolvedValueOnce(missing)
        .mockReturnValueOnce(older.promise).mockResolvedValue(installed),
    };
    const { toggle, user } = setup(modelStore);
    await act(async () => {});
    fireEvent.focus(window);
    await user.click(refreshButton());
    expect(modelStore.status).toHaveBeenCalledTimes(3);
    await act(async () => older.resolve(missing));
    expect(toggle).toBeEnabled();
  });

  it('does not enable from stale readiness after a failed refresh', async () => {
    const modelStore = {
      importModel: vi.fn(),
      status: vi.fn().mockResolvedValueOnce(installed)
        .mockRejectedValueOnce(new Error('cannot query model'))
        .mockResolvedValue(installed),
    };
    const { toggle, user } = setup(modelStore, { modelId: installed.id });
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(refreshButton());
    expect(toggle).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('cannot query model');
    expect(screen.queryByText('No cleanup model installed.'))
      .not.toBeInTheDocument();
    await user.click(refreshButton());
    expect(toggle).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not race focus refresh against an open import picker', async () => {
    const imported = deferred<CleanupModelStatus | null>();
    const modelStore = {
      importModel: vi.fn().mockReturnValue(imported.promise),
      status: vi.fn().mockResolvedValueOnce(missing)
        .mockResolvedValue(installed),
    };
    const { toggle, user } = setup(modelStore);
    await user.click(importButton());
    fireEvent.focus(window);
    expect(modelStore.status).toHaveBeenCalledTimes(1);
    expect(refreshButton()).toBeDisabled();
    await act(async () => imported.resolve(installed));
    expect(modelStore.status).toHaveBeenCalledTimes(2);
    expect(toggle).toBeEnabled();
  });

  it('ignores an import that settles after unmount', async () => {
    const imported = deferred<CleanupModelStatus | null>();
    const modelStore = {
      importModel: vi.fn().mockReturnValue(imported.promise),
      status: vi.fn().mockResolvedValue(missing),
    };
    const { onModelChange, unmount, user } = setup(modelStore);
    await user.click(importButton());
    unmount();
    await act(async () => imported.resolve(installed));
    expect(onModelChange).not.toHaveBeenCalled();
    expect(modelStore.status).toHaveBeenCalledTimes(1);
  });

  it('honors persisted selection and opt-in on remount without importing', async () => {
    const modelStore = {
      importModel: vi.fn(),
      status: vi.fn().mockResolvedValue(installed),
    };
    const { onModelChange, toggle } = setup(modelStore, {
      enabled: true,
      modelId: installed.id,
    });
    await waitFor(() => expect(modelStore.status).toHaveBeenCalledOnce());
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
    expect(onModelChange).not.toHaveBeenCalled();
    expect(modelStore.importModel).not.toHaveBeenCalled();
  });

  it('does not enable a model different from the selected one', async () => {
    const { toggle } = setup({
      importModel: vi.fn(),
      status: vi.fn().mockResolvedValue(installed),
    }, { modelId: 'unsupported-model' });
    await act(async () => {});
    expect(toggle).toBeDisabled();
    expect(screen.getByText(/Import.*select.*supported model/i))
      .toBeInTheDocument();
  });

  it('does not query or import outside the native app', async () => {
    const modelStore = { importModel: vi.fn(), status: vi.fn() };
    const { toggle } = setup(modelStore, { isNative: false });
    fireEvent.focus(window);
    expect(modelStore.status).not.toHaveBeenCalled();
    expect(importButton()).toBeDisabled();
    expect(refreshButton()).toBeDisabled();
    expect(toggle).toBeDisabled();
  });
});

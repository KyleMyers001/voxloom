import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CleanupSettings } from
  '../../src/features/settings/CleanupSettings';

describe('CleanupSettings', () => {
  it('requires a validated runtime before enabling', async () => {
    const user = userEvent.setup();
    const available = {
      available: true,
      id: 'qwen3-0.6b-q4-k-m',
      runtimeAvailable: true,
      sha256: 'digest',
    };
    const modelStore = {
      importModel: vi.fn().mockResolvedValue(available),
      status: vi.fn().mockResolvedValue({
        ...available,
        available: false,
      }),
    };
    const onEnabledChange = vi.fn();
    const onModelChange = vi.fn();
    render(<CleanupSettings
      enabled={false}
      isNative
      modelId={null}
      modelStore={modelStore}
      onEnabledChange={onEnabledChange}
      onModelChange={onModelChange}
    />);

    const toggle = screen.getByLabelText(
      /Clean transcripts with the imported local model/,
    );
    expect(toggle).toBeDisabled();
    await user.click(screen.getByLabelText(
      /Language-processing model import/,
    ));
    expect(modelStore.importModel).toHaveBeenCalledOnce();
    expect(toggle).toBeEnabled();
    expect(onModelChange).toHaveBeenCalledWith(available.id);
    await user.click(toggle);
    expect(onEnabledChange).toHaveBeenCalledWith(true);
  });
});

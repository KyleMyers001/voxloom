import { invoke, isTauri } from '@tauri-apps/api/core';

/** System Settings privacy panes Voxloom can deep-link to (native allowlist). */
export type PrivacyPane = 'accessibility';

export const PRIVACY_PANE_LABEL: Record<PrivacyPane, string> = {
  accessibility: 'Accessibility',
};

/** Open the pane; never prompts for or changes a permission. */
export async function openPrivacyPane(pane: PrivacyPane): Promise<void> {
  if (!isTauri()) throw new Error('System Settings is only available in the Mac app');
  await invoke('privacy_pane_open', { pane });
}

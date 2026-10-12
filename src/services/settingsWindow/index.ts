/**
 * Settings window bridge (UI PR 6b). Labels/events mirror
 * src-tauri/src/settings_window.rs. Every call no-ops outside Tauri.
 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const SETTINGS_WINDOW_LABEL = 'settings';
export const SETTINGS_CHANGED_EVENT = 'settings:changed';
export const ONBOARDING_OPEN_EVENT = 'onboarding:open';

export interface SettingsChangedPayload {
  contents: string;
}

type Unlisten = () => void;

/** Open the native Settings window, or focus it if it is already open. */
export async function openSettingsWindow(): Promise<void> {
  if (!isTauri()) return;
  await invoke('settings_window_open');
}

/** From the Settings window: focus main and open onboarding there. */
export async function requestOnboarding(): Promise<void> {
  if (!isTauri()) return;
  await invoke('settings_request_onboarding');
}

async function listenTo<T>(event: string, handler: (payload: T) => void): Promise<Unlisten> {
  if (!isTauri()) return () => {};
  return listen<T>(event, (e) => handler(e.payload));
}

/** Another window saved settings.json. Rust never echoes to the sender. */
export function listenSettingsChanged(handler: (payload: SettingsChangedPayload) => void) {
  return listenTo(SETTINGS_CHANGED_EVENT, handler);
}

export function listenOnboardingOpen(handler: () => void) {
  return listenTo<null>(ONBOARDING_OPEN_EVENT, () => handler());
}

/** Subscribe in an effect; returns the effect cleanup. Handles unmount-before-resolve. */
export function subscribe(start: () => Promise<Unlisten>): () => void {
  let unlisten: Unlisten | null = null;
  let disposed = false;
  void start().then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  }).catch(() => {});
  return () => {
    disposed = true;
    unlisten?.();
  };
}

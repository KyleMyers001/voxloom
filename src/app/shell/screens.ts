import type { IconName } from '../../components/Icon';
import type { Screen } from '../../domain/types';

/** Sidebar screens (⌥1–3). Settings is opened from the title bar, ⌥4 or ⌘,. */
export const navScreens: { icon: IconName; label: string; value: Screen }[] = [
  { icon: 'house', label: 'Home', value: 'home' },
  { icon: 'clock', label: 'History', value: 'history' },
  { icon: 'book', label: 'Dictionary', value: 'dictionary' },
];

/** Alt+1…4 → screen; 4 opens Settings (in-page until the Settings window lands in UI PR 6). */
export function screenForAltDigit(key: string): Screen | null {
  if (!/^[1-4]$/.test(key)) return null;
  return key === '4' ? 'settings' : navScreens[Number(key) - 1].value;
}

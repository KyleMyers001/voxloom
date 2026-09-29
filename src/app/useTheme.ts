import { useEffect } from 'react';
import type { Appearance } from '../domain/types';

export function resolveAppearance(
  appearance: Appearance,
  systemDark: boolean,
): Exclude<Appearance, 'system'> {
  return appearance === 'system'
    ? systemDark ? 'dark' : 'light'
    : appearance;
}

export function useTheme(appearance: Appearance) {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      document.body.dataset.appearanceResolved = resolveAppearance(
        appearance,
        media.matches,
      );
    };
    applyTheme();
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [appearance]);
}

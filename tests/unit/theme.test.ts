import { describe, expect, it } from 'vitest';
import { resolveAppearance } from '../../src/app/useTheme';

describe('resolveAppearance', () => {
  it('tracks both system preferences and preserves explicit themes', () => {
    expect(resolveAppearance('system', true)).toBe('dark');
    expect(resolveAppearance('system', false)).toBe('light');
    expect(resolveAppearance('dark', false)).toBe('dark');
    expect(resolveAppearance('light', true)).toBe('light');
  });
});

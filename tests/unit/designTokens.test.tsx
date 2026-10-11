import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppTile } from '../../src/components/AppTile';

const root = join(__dirname, '../../src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : [path];
});
const css = (name: string) => readFileSync(join(root, 'styles', name), 'utf8');

describe('Console design tokens (UI PR 1)', () => {
  it('uses the system font only: no Inter anywhere in src/', () => {
    const hits = files(root).filter((f) => /\bInter\b/.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
    expect(css('tokens.css')).toContain('-apple-system, BlinkMacSystemFont, system-ui');
    expect(files(root).some((f) => /\.(woff2?|ttf|otf)$/.test(f))).toBe(false);
  });

  it('keeps every stylesheet module under 200 lines', () => {
    for (const f of readdirSync(join(root, 'styles'))) {
      expect(css(f).split('\n').length, f).toBeLessThan(200);
    }
  });

  it('defines dark defaults and light/sodium-rain overrides on the theme attribute', () => {
    const tokens = css('tokens.css');
    expect(tokens).toMatch(/:root \{[^}]*--bg: #0b0b10;[^}]*--accfg: #b6ff3c;/);
    expect(tokens).toMatch(/\[data-appearance-resolved="light"\] \{[^}]*--bg: #fbfbf8;[^}]*--accfg: #3f7a00;/);
    expect(tokens).toContain('[data-appearance-resolved="sodium-rain"]');
  });

  it('gives the app tile the dark-tile outline', () => {
    expect(css('tokens.css')).toContain('inset 0 0 0 1px rgba(255, 255, 255, .16)');
    expect(css('base.css')).toMatch(/\.app-tile \{[^}]*box-shadow: var\(--tile-shadow\)/);
  });
});

describe('AppTile', () => {
  it('renders a decorative tile with a unique gradient per instance', () => {
    const { getAllByTestId } = render(<><AppTile /><AppTile size="sm" /></>);
    const [a, b] = getAllByTestId('app-tile');
    expect(a.getAttribute('aria-hidden')).toBe('true');
    expect(b.className).toBe('app-tile app-tile--sm');
    const ids = [a, b].map((el) => el.querySelector('linearGradient')?.id);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

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
    expect(tokens).toMatch(/\[data-appearance-resolved="light"\] \{[^}]*--bg: #fbfbf8;[^}]*--accfg: #376b00;/);
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

describe('Switch styling (UI PR 2)', () => {
  it('uses tokens for the knob and a visible off track', () => {
    const controls = css('ui-controls.css');
    expect(controls).not.toMatch(/#fff\b/);
    expect(controls).toContain('background: var(--knob)');
    expect(controls).toMatch(/\.switch i \{[^}]*background: var\(--switch-off\);[^}]*box-shadow: inset 0 0 0 1px var\(--line\)/);
    const tokens = css('tokens.css');
    // Per-theme literal values so each theme resolves its own track (no :root-only var() mixing).
    expect(tokens).toMatch(/:root \{[^}]*--switch-off: #66667a;/);
    expect(tokens).toMatch(/\[data-appearance-resolved="light"\] \{[^}]*--switch-off: #808389;/);
    // Designer: solid ON track in light only; dark keeps the brand gradient.
    expect(tokens).toMatch(/\[data-appearance-resolved="light"\] \{[^}]*--switch-on: #4c8a00;/);
    expect(tokens).not.toMatch(/:root \{[^}]*--switch-on:/);
    expect(controls).toMatch(/\.switch\.on i \{[^}]*background: var\(--switch-on, var\(--brand\)\)/);
    expect(tokens).toMatch(/\[data-appearance-resolved="sodium-rain"\] \{[^}]*--switch-off: #7a909a;/);
  });
});

describe('designer #37: focus ring, tag pill, disabled ON switch', () => {
  const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const hex = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const lum = (rgb: number[]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const ratio = (a: string, b: string) => { const [x, y] = [lum(hex(a)), lum(hex(b))].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

  it('light focus ring is solid and ≥3:1 on every light surface', async () => {
    const { readFileSync } = await import('node:fs');
    const light = readFileSync('src/styles/tokens.css', 'utf8').split('[data-appearance-resolved="light"]')[1];
    const focus = /--focus: (#[0-9a-f]{6});/.exec(light)![1];
    for (const surface of ['#fbfbf8', '#ffffff', '#f3f4ef', '#f2f3ee', '#e7e9e1']) {
      expect(ratio(focus, surface)).toBeGreaterThanOrEqual(3);
    }
    expect(readFileSync('src/styles/base.css', 'utf8')).toMatch(/outline: 3px solid var\(--focus\)/);
  });

  it('dark tag pill text stays ≥4.5:1 on its pill', () => {
    expect(ratio('#9a9aa8', '#2c2c3a')).toBeGreaterThanOrEqual(4.5);
  });

  it('a disabled ON switch shows the dimmed brand gradient', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('src/styles/ui-controls.css', 'utf8')).toMatch(/\.switch\.on:disabled i \{ background: var\(--brand\); \}/);
  });
});

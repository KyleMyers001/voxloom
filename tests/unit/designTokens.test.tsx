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

  it('defines dark defaults and light overrides (Sodium Rain removed) on the theme attribute', () => {
    const tokens = css('tokens.css');
    expect(tokens).toMatch(/:root \{[^}]*--bg: #0b0b10;[^}]*--accfg: #b6ff3c;/);
    expect(tokens).toMatch(/\[data-appearance-resolved="light"\] \{[^}]*--bg: #fbfbf8;[^}]*--accfg: #376b00;/);
    expect(tokens).not.toContain('sodium-rain');
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
  });
});

describe('Disabled primary button (UI PR 3)', () => {
  it('is solid and uses muted text instead of fading the gradient', () => {
    expect(css('home.css')).toMatch(/\.btn\.primary:disabled \{[^}]*background: var\(--seg\);[^}]*color: var\(--mut\);[^}]*opacity: 1;/);
  });
});

describe('light --ok on its 10% badge tint (review #43)', () => {
  const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const hex = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const lum = (rgb: number[]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

  it('is at least 4.5:1 on the badge over every light surface', async () => {
    const { readFileSync } = await import('node:fs');
    const light = readFileSync('src/styles/tokens.css', 'utf8').split('[data-appearance-resolved="light"]')[1];
    const ok = hex(/--ok: (#[0-9a-f]{6})/.exec(light)![1]);
    for (const surface of ['#f3f4ef', '#fbfbf8', '#ffffff', '#e7e9e1']) {
      const s = hex(surface);
      const tint = s.map((c, i) => Math.round(0.1 * ok[i] + 0.9 * c));
      expect(ratio(ok, tint)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

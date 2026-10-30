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
    // field, bg, panel, seg, navon (selected row)
    for (const surface of ['#f3f4ef', '#fbfbf8', '#ffffff', '#e7e9e1', '#e7eadf']) {
      const s = hex(surface);
      const tint = s.map((c, i) => Math.round(0.1 * ok[i] + 0.9 * c));
      expect(ratio(ok, tint)).toBeGreaterThanOrEqual(4.5);
    }
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

describe('Appearance swatches use Console tokens (designer #46)', () => {
  it('no Sodium blue/teal; Follow system is a split light/dark preview with the lime dot', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/styles/features.css', 'utf8');
    for (const sodium of ['#5f8fff', '#2f62a6', '#79b8c9', '#0b111b', '#162130', '#182127']) expect(css).not.toContain(sodium);
    const system = /\[data-preview="system"\] \{([^}]*)\}/.exec(css)![1];
    expect(system).toMatch(/--preview-accent: #b6ff3c/);
    expect(system).toMatch(/background: linear-gradient\(90deg, #fbfbf8 50%, #0b0b10 50%\)/);
    expect(/\[data-preview="dark"\] \{([^}]*)\}/.exec(css)![1]).toMatch(/--preview-bg: #0b0b10/);
    expect(/\[data-preview="light"\] \{([^}]*)\}/.exec(css)![1]).toMatch(/--preview-accent: #376b00/);
  });
});

describe('app focus ring reaches every focusable (QA #38)', () => {
  it('the Developer disclosure and search field use --focus', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('src/styles/base.css', 'utf8')).toMatch(/summary:focus-visible,[^{]*\{\s*outline: 3px solid var\(--focus\)/);
    expect(readFileSync('src/styles/ui-controls.css', 'utf8')).not.toMatch(/42%, transparent\);\s*outline-offset/);
  });
});

describe('History rows take the app focus ring (QA)', () => {
  it('styles .history-row:focus-visible with --focus', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('src/styles/base.css', 'utf8')).toMatch(/\.history-row:focus-visible,[^{]*\{\s*outline: 3px solid var\(--focus\)/);
  });
});

describe('Dictionary rows take the app focus ring (QA)', () => {
  it('styles .term-row:focus-visible with --focus', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('src/styles/base.css', 'utf8')).toMatch(/\.term-row:focus-visible,[^{]*\{\s*outline: 3px solid var\(--focus\)/);
  });
});

describe('BUS-51 brand tokens', () => {
  const tokens = css('tokens.css');
  it('defines --brand-a/--brand-b and builds --brand, --tile-glow and --hud-shadow from them', () => {
    expect(tokens).toMatch(/:root \{[^}]*--brand-a: #b6ff3c;[^}]*--brand-b: #3cf0ff;[^}]*--brand: linear-gradient\(90deg, var\(--brand-a\), var\(--brand-b\)\);/);
    expect(tokens).toContain('--tile-glow: color-mix(in srgb, var(--brand-a) 25%, transparent);');
    expect(tokens).toMatch(/--hud-shadow:[^;]*color-mix\(in srgb, var\(--brand-a\) 35%, transparent\)[^;]*color-mix\(in srgb, var\(--brand-b\) 18%, transparent\);/);
    expect(css('home.css')).toContain('0 0 40px var(--tile-glow)');
  });

  it('keeps raw brand hex and rgba out of hud.css', () => {
    const hud = css('hud.css');
    expect(hud).not.toMatch(/#(b6ff3c|3cf0ff)\b/i);
    expect(hud).not.toMatch(/rgba\((182, 255, 60|60, 240, 255)/);
    expect(hud).toMatch(/\.hud-result \{[^}]*box-shadow: inset 0 0 0 1px color-mix\(in srgb, var\(--brand-a\) 35%, transparent\)[^;]*color-mix\(in srgb, var\(--brand-b\) 14%, transparent\);/);
  });

  it('paints the AppTile gradient with the brand tokens', () => {
    const { getByTestId } = render(<AppTile />);
    const stops = [...getByTestId('app-tile').querySelectorAll('stop')].map((s) => s.getAttribute('style'));
    expect(stops).toEqual(['stop-color: var(--brand-a);', 'stop-color: var(--brand-b);']);
  });

});

describe('BUS-48 contrast tokens', () => {
  const tokens = css('tokens.css');
  it('raises dark --mut and keeps light --mut', () => {
    expect(tokens).toMatch(/:root \{[^}]*--mut: #9494a3;/);
    expect(tokens).toMatch(/\[data-appearance-resolved="light"\] \{[^}]*--mut: #5d6068;/);
  });

  it('defines per-theme --ctl-line and --sel-edge', () => {
    expect(tokens).toMatch(/:root \{[^}]*--ctl-line: #6a6a80;[^}]*--sel-edge: #70943a;/);
    expect(tokens).toMatch(/\[data-appearance-resolved="light"\] \{[^}]*--ctl-line: #808389;[^}]*--sel-edge: #376b00;/);
  });

  it('borders form controls and .btn with --ctl-line', () => {
    expect(css('base.css')).toMatch(/input,\nselect,\ntextarea \{[^}]*border: 1px solid var\(--ctl-line\)/);
    expect(css('components.css')).toMatch(/\.btn \{[^}]*border-color: var\(--ctl-line\)/);
    expect(css('ui-controls.css')).toMatch(/\.search \{[^}]*border: 1px solid var\(--ctl-line\)/);
    expect(css('shell.css')).toMatch(/\.tb-settings\[aria-current="page"\] \{ box-shadow: inset 0 -2px 0 var\(--sel-edge\); \}/);
    expect(css('shell.css')).toMatch(/\.tb-help \{[^}]*border: 1px solid var\(--ctl-line\)/);
  });

  it('marks selected nav, settings tab and segment with --sel-edge', () => {
    expect(css('shell.css')).toMatch(/\.nav-button\[aria-current="page"\] \{[^}]*box-shadow: inset 3px 0 0 var\(--sel-edge\)/);
    expect(css('settings.css')).toMatch(/\.settings-tab\[aria-selected="true"\] \{[^}]*box-shadow: inset 0 -2px 0 var\(--sel-edge\)/);
    expect(css('ui-controls.css')).toMatch(/\.seg__item\.on \{[^}]*box-shadow: inset 0 0 0 1px var\(--sel-edge\)/);
  });
});

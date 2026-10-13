import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(__dirname, '../../src/styles');
const css = (name: string) => readFileSync(join(dir, name), 'utf8');
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.css') ? [join(d, e.name)] : []);
// font-size or the font shorthand with any literal length (px, rem, em, pt).
const LITERAL = /font(?:-size)?\s*:[^;}]*\b\d*\.?\d+(px|rem|em|pt)\b/i;
/** [selector, declaration] pairs that set a literal font size. */
export function literalFontSizes(source: string): [string, string][] {
  const out: [string, string][] = [];
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const decl of m[2].split(';')) {
      if (LITERAL.test(decl)) out.push([m[1].trim(), decl.trim()]);
    }
  }
  return out;
}

describe('BUS-41 type scale tokens', () => {
  it('defines each size as windowed (≤1280px) growing linearly to fullscreen (≥1920px)', () => {
    const tokens = css('tokens.css');
    const scale: [string, number, number][] = [
      ['micro', 11, 12], ['badge', 11.5, 13], ['label', 12, 13.5], ['secondary', 13, 14.5],
      ['mono', 12.5, 14], ['body', 15, 17], ['emph', 16, 18], ['section', 16, 18.5],
      ['sheet', 17, 19.5], ['hero', 30, 37], ['page', 34, 42], ['bigkey', 20, 24],
    ];
    const [root, mid, top] = [
      tokens.slice(0, tokens.indexOf('@media (min-width: 1281px)')),
      tokens.slice(tokens.indexOf('@media (min-width: 1281px)'), tokens.indexOf('@media (min-width: 1920px)')),
      tokens.slice(tokens.indexOf('@media (min-width: 1920px)')),
    ];
    for (const [name, lo, hi] of scale) {
      expect(root, name).toContain(`--fsb-${name}: ${lo}px;`);
      expect(top, name).toContain(`--fsb-${name}: ${hi}px;`);
      const m = new RegExp(`--fsb-${name}: calc\\(([\\d.]+)px \\+ ([\\d.]+)vw\\);`).exec(mid);
      expect(m, name).not.toBeNull();
      const at = (w: number) => Number(m![1]) + Number(m![2]) * w / 100;
      expect(at(1280), name).toBeCloseTo(lo, 2);
      expect(at(1920), name).toBeCloseTo(hi, 2);
    }
    // clamp() needs Safari 13.1 (macOS 10.15.4); the app supports 10.15.0.
    expect(tokens).not.toMatch(/--fsb?-[\w-]+: clamp\(/);
    expect(tokens).not.toContain('--fs-caption');
  });

  it('uses tokens instead of hard-coded font sizes (the HUD keeps its own)', () => {
    const src = join(__dirname, '../../src');
    const files = walk(src).filter(
      (p) => !['styles/hud.css', 'styles/tokens.css'].includes(relative(src, p).split('\\').join('/')),
    );
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const hits = literalFontSizes(readFileSync(f, 'utf8'));
      expect(hits, f).toEqual([]);
    }
  });

  it('catches the ways around the guard', () => {
    for (const bad of ['a{font-size:13px}', 'a { font: 600 13px/1.2 x; }', 'a{font-size: .8rem}',
      'a{font-size:1em}', 'a{font-size:10pt}', 'a{font-size:13PX}', '.other{font-size: 22px;}']) {
      expect(literalFontSizes(bad), bad).not.toEqual([]);
    }
    expect(literalFontSizes('a{font-size: var(--fs-body); font: inherit}')).toEqual([]);
  });

  it('keeps the HUD on its own size', () => {
    expect(css('hud.css')).toContain('font-size: 12.5px;');
    expect(css('hud.css')).not.toContain('var(--fs-');
  });
});

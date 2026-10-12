import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(__dirname, '../../src/styles');
const css = (name: string) => readFileSync(join(dir, name), 'utf8');

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
      expect(root, name).toContain(`--fs-${name}: ${lo}px;`);
      expect(top, name).toContain(`--fs-${name}: ${hi}px;`);
      const m = new RegExp(`--fs-${name}: calc\\(([\\d.]+)px \\+ ([\\d.]+)vw\\);`).exec(mid);
      expect(m, name).not.toBeNull();
      const at = (w: number) => Number(m![1]) + Number(m![2]) * w / 100;
      expect(at(1280), name).toBeCloseTo(lo, 2);
      expect(at(1920), name).toBeCloseTo(hi, 2);
    }
    // macOS 10.15 WKWebView: no calc() multiplication, no clamp().
    expect(tokens).not.toMatch(/calc\([^)]*\*/);
    expect(tokens).not.toMatch(/--fs-[\w-]+: clamp\(/);
    expect(tokens).not.toContain('--fs-caption');
  });

  it('uses tokens instead of hard-coded font sizes (the HUD keeps its own)', () => {
    for (const f of readdirSync(dir).filter((n) => !['hud.css', 'tokens.css'].includes(n))) {
      const sizes = css(f).match(/font-size: \d[^;]*;/g) ?? [];
      // .modal-close's 22px is the close glyph, not text.
      expect(sizes.filter((s) => s !== 'font-size: 22px;'), f).toEqual([]);
    }
    expect(css('hud.css')).toContain('font-size: 12.5px;');
    expect(css('hud.css')).not.toContain('var(--fs-');
  });
});

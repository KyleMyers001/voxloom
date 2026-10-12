import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(__dirname, '../../src/styles');
const css = (name: string) => readFileSync(join(dir, name), 'utf8');

describe('BUS-41 type scale tokens', () => {
  it('defines each size as windowed (≤1280px) growing to fullscreen (≥1920px)', () => {
    const tokens = css('tokens.css');
    const scale: [string, number, number][] = [
      ['micro', 11, 12], ['badge', 11.5, 13], ['label', 12, 13.5], ['secondary', 13, 14.5],
      ['mono', 12.5, 14], ['body', 15, 17], ['emph', 16, 18], ['section', 16, 18.5],
      ['sheet', 17, 19.5], ['hero', 30, 37], ['page', 34, 42], ['bigkey', 20, 24],
    ];
    for (const [name, lo, hi] of scale) {
      expect(tokens, name).toMatch(new RegExp(`--fs-${name}: clamp\\(${lo}px, calc\\(${lo}px \\+ \\(100vw - 1280px\\) \\* [.\\d]+\\), ${hi}px\\);`));
    }
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

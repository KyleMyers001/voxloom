import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '../../src/styles/scale-layout.css'), 'utf8');
const [root, mid, top] = [
  css.slice(0, css.indexOf('@media (min-width: 1281px)')),
  css.slice(css.indexOf('@media (min-width: 1281px)'), css.indexOf('@media (min-width: 1920px)')),
  css.slice(css.indexOf('@media (min-width: 1920px)')),
];

describe('BUS-41 layout tokens', () => {
  it('grow linearly from windowed (<=1280px) to fullscreen (>=1920px)', () => {
    const scale: [string, number, number][] = [
      ['content-max', 1080, 1240], ['pad-x', 32, 56], ['ctl', 32, 36], ['side-w', 244, 272],
      ['kbd-min', 22, 24], ['bigkey', 46, 50], ['seg-x', 12, 14],
    ];
    for (const [name, lo, hi] of scale) {
      expect(root, name).toContain(`--${name}: ${lo}px;`);
      expect(top, name).toContain(`--${name}: ${hi}px;`);
      const m = new RegExp(`--${name}: calc\\((-?[\\d.]+)px \\+ ([\\d.]+)vw\\);`).exec(mid);
      expect(m, name).not.toBeNull();
      const at = (w: number) => Number(m![1]) + Number(m![2]) * w / 100;
      expect(at(1280), name).toBeCloseTo(lo, 2);
      expect(at(1920), name).toBeCloseTo(hi, 2);
    }
    expect(css).not.toMatch(/clamp\(/);
  });

  it('narrows the sidebar to 200px at <=900 and 184px at <=780', () => {
    expect(css).toContain('@media (max-width: 900px) { :root { --side-w: 200px; } }');
    expect(css).toContain('@media (max-width: 780px) { :root { --side-w: 184px; } }');
    expect(css.indexOf('max-width: 900px')).toBeLessThan(css.indexOf('max-width: 780px'));
  });

  it('centers the main column and caps line length', () => {
    expect(css).toMatch(/\.main \{ margin-inline: auto; max-width: var\(--content-max\); \}/);
    expect(css).toContain('max-width: 72ch');
    expect(css).toContain('.history-row .history-row__text { max-width: 78ch; }');
    expect(css).toContain('repeat(auto-fill, minmax(17em, 1fr))');
  });
});

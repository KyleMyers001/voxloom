import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSettingsJson, serializeSettingsFile } from '../../src/services/settings';
import { initialSettings } from '../../src/domain/fixtures';

const tokens = readFileSync(join(__dirname, '../../src/styles/tokens.css'), 'utf8');
const NAMES = ['micro', 'badge', 'label', 'secondary', 'mono', 'body', 'emph', 'section', 'sheet', 'hero', 'page', 'bigkey'];

/** Base px of --fsb-{name} at a viewport width, read from tokens.css. */
function base(name: string, width: number): number {
  const mid = tokens.slice(tokens.indexOf('@media (min-width: 1281px)'), tokens.indexOf('@media (min-width: 1920px)'));
  const top = tokens.slice(tokens.indexOf('@media (min-width: 1920px)'));
  if (width >= 1920) return Number(new RegExp(`--fsb-${name}: ([\\d.]+)px;`).exec(top)![1]);
  if (width > 1280) {
    const m = new RegExp(`--fsb-${name}: calc\\(([\\d.-]+)px \\+ ([\\d.]+)vw\\);`).exec(mid)!;
    return Number(m[1]) + Number(m[2]) * width / 100;
  }
  return Number(new RegExp(`--fsb-${name}: ([\\d.]+)px;`).exec(tokens)![1]);
}
const factor = (size: string) => Number(new RegExp(`data-textsize="${size}"\\] \\{ --ts: ([\\d.]+); \\}`).exec(tokens)![1]);

describe('BUS-41 Text size', () => {
  it('multiplies every token by --ts with an 11px floor, without clamp()', () => {
    expect(tokens).toContain('--ts: 1;');
    for (const n of NAMES) {
      expect(tokens, n).toContain(`--fs-${n}: max(11px, calc(var(--fsb-${n}) * var(--ts)));`);
    }
    expect(tokens.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('clamp(');
    expect(factor('small')).toBeCloseTo(0.92);
    expect(factor('large')).toBeCloseTo(1.12);
  });

  it('keeps Small at or above 11px at every width', () => {
    for (let w = 640; w <= 2560; w += 10) {
      for (const n of NAMES) {
        const px = Math.max(11, base(n, w) * factor('small'));
        expect(px, `${n}@${w}`).toBeGreaterThanOrEqual(11);
      }
    }
    // The floor is what holds it: micro alone would be 10.12px.
    expect(base('micro', 760) * factor('small')).toBeLessThan(11);
  });

  it('defaults to Default and migrates older settings files without textSize', () => {
    expect(initialSettings.textSize).toBe('default');
    const legacy = JSON.stringify({ onboardingComplete: true, settings: { appearance: 'dark', shortcut: 'Ctrl + Alt + K' }, version: 1 });
    const parsed = parseSettingsJson(legacy);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.settings.textSize).toBe('default');
    expect(parsed.file.settings.appearance).toBe('dark');
    expect(JSON.parse(serializeSettingsFile(parsed.file.settings, true)).settings.textSize).toBe('default');
  });

  it('round-trips a chosen size and coerces junk to Default', () => {
    const file = (v: unknown) => JSON.stringify({ onboardingComplete: true, settings: { textSize: v }, version: 1 });
    const large = parseSettingsJson(file('large'));
    expect(large.ok && large.file.settings.textSize).toBe('large');
    const junk = parseSettingsJson(file('huge'));
    expect(junk.ok && junk.file.settings.textSize).toBe('default');
  });
});

describe('useTextSize', () => {
  it('sets data-textsize on <html> and follows changes (the HUD window never calls it)', async () => {
    const { renderHook } = await import('@testing-library/react');
    const { useTextSize } = await import('../../src/app/useTheme');
    const { rerender } = renderHook(({ size }) => useTextSize(size), { initialProps: { size: 'large' as const } as { size: 'small' | 'default' | 'large' } });
    expect(document.documentElement.dataset.textsize).toBe('large');
    rerender({ size: 'small' });
    expect(document.documentElement.dataset.textsize).toBe('small');
    const overlay = readFileSync(join(__dirname, '../../src/overlay/OverlayApp.tsx'), 'utf8');
    expect(overlay).not.toContain('useTextSize');
  });
});

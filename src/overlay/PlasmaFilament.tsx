import { useId } from 'react';
import { clampDisplayLevel, WAVEFORM_BARS } from '../components/Waveform';

/** Three bounded, deterministic filaments; no canvas, filter or animation loop. */
export function PlasmaFilament({ levels }: { levels: readonly number[] }) {
  const gradient = useId();
  // The same 24 sanitized display samples as the bars, not raw microphone audio.
  const energy = Array.from({ length: WAVEFORM_BARS }, (_, i) => clampDisplayLevel(levels[i] ?? 0))
    .reduce((sum, level) => sum + level, 0) / WAVEFORM_BARS;
  const paths = [0, 1, 2].map((layer) => {
    const radius = 11;
    const straight = 114;
    const perimeter = 2 * straight + 2 * Math.PI * radius;
    return Array.from({ length: 161 }, (_, index) => {
      const u = index / 160;
      let distance = u * perimeter;
      let x: number, y: number, nx: number, ny: number;
      if (distance < straight) {
        x = 38 + distance; y = 27; nx = 0; ny = -1;
      } else if ((distance -= straight) < Math.PI * radius) {
        const angle = -Math.PI / 2 + distance / radius;
        nx = Math.cos(angle); ny = Math.sin(angle);
        x = 152 + nx * radius; y = 38 + ny * radius;
      } else if ((distance -= Math.PI * radius) < straight) {
        x = 152 - distance; y = 49; nx = 0; ny = 1;
      } else {
        distance -= straight;
        const angle = Math.PI / 2 + distance / radius;
        nx = Math.cos(angle); ny = Math.sin(angle);
        x = 38 + nx * radius; y = 38 + ny * radius;
      }
      const phase = u * 2 * Math.PI;
      const displacement = (Math.sin(phase * 9 + layer * 1.7)
        + 0.45 * Math.sin(phase * 19 - layer)) * (layer === 0 ? 0.65 : 1.2) * (0.65 + energy * 1.1);
      return `${index === 0 ? 'M' : 'L'}${(x + nx * displacement).toFixed(2)},${(y + ny * displacement).toFixed(2)}`;
    }).join(' ') + ' Z';
  });
  return (
    <svg aria-hidden="true" className="hud-plasma" focusable="false" style={{ opacity: 0.38 + energy * 0.55 }} viewBox="0 0 190 76">
      <defs>
        <linearGradient id={gradient} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#b6ff3c" />
          <stop offset=".48" stopColor="#e4ffb1" />
          <stop offset=".72" stopColor="#3cf0ff" />
          <stop offset="1" stopColor="#b6ff3c" />
        </linearGradient>
      </defs>
      {paths.map((path, layer) => <path key={layer} className={`hud-plasma__filament hud-plasma__filament--${layer}`} d={path} fill="none" stroke={`url(#${gradient})`} />)}
    </svg>
  );
}

import type { CSSProperties } from 'react';
import type { OverlayWaveform } from '../services/shortcut/overlayVisibility';

export const WAVEFORM_BARS = 24;

/** Display metadata may cross a window boundary; never emit invalid CSS. */
export function clampDisplayLevel(level: number): number {
  return Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
}

/** Per-frame RMS is metadata only; map speech into a legible display range. */
export function toDisplayLevel(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return 0;
  return Math.min(1, Math.max(0, (Math.sqrt(level) - 0.04) / 0.4));
}

interface Props {
  levels: readonly number[];
  waveform: OverlayWaveform;
}

export function Waveform({ levels, waveform }: Props) {
  return (
    <div
      aria-label={waveform === 'processing' ? 'Transcribing' : 'Microphone level'}
      className="wave"
      role="img"
    >
      {Array.from({ length: WAVEFORM_BARS }, (_, index) => {
        const level = clampDisplayLevel(levels[index] ?? 0);
        return <i
          key={index}
          style={{ '--h': `${1 + Math.round(level * 12)}px` } as CSSProperties}
        />;
      })}
    </div>
  );
}

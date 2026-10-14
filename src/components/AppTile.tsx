import { useId } from 'react';

export type AppTileSize = 'sm' | 'md' | 'lg';

/**
 * Brand tile: dark gradient square with lime→cyan bars. Carries the
 * dark-tile outline fix (inner hairline + sheen + outer shadow) so it stays
 * visible on dark backgrounds. Decorative; label it with adjacent text.
 */
export function AppTile({ size = 'md' }: { size?: AppTileSize }) {
  const gradientId = `vx-tile-${useId().replace(/:/g, '')}`;
  const className = size === 'md' ? 'app-tile' : `app-tile app-tile--${size}`;
  return (
    <span aria-hidden="true" className={className} data-testid="app-tile">
      <svg viewBox="0 0 24 24">
        <defs>
          <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--brand-a)' }} />
            <stop offset="1" style={{ stopColor: 'var(--brand-b)' }} />
          </linearGradient>
        </defs>
        <rect fill={`url(#${gradientId})`} height="9" rx="2.25" width="4.5" x="3" y="7.5" />
        <rect fill={`url(#${gradientId})`} height="18" rx="2.25" width="4.5" x="9.75" y="3" />
        <rect fill={`url(#${gradientId})`} height="12" rx="2.25" width="4.5" x="16.5" y="6" />
      </svg>
    </span>
  );
}

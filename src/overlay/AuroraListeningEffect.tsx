import type { CSSProperties } from 'react';
import '../styles/hud-aurora.css';

/** Decorative light only; the existing waveform remains the accessible meter. */
export function AuroraListeningEffect({ energy }: { energy: number }) {
  return (
    <span aria-hidden="true" className="hud-aurora" style={{ '--aurora-energy': energy } as CSSProperties}>
      <span className="hud-aurora__halo"><span className="hud-aurora__band"><i className="hud-aurora__flow" /></span></span>
      <span className="hud-aurora__rim"><i className="hud-aurora__flow" /></span>
    </span>
  );
}

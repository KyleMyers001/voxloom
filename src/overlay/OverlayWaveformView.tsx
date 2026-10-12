import { Icon } from '../components/Icon';
import { isMacPlatform } from '../components/KeyCombo';
import { Waveform } from '../components/Waveform';
import type { OverlayResult, OverlayWaveform } from '../services/shortcut/overlayVisibility';

interface Props {
  levels: readonly number[];
  waveform: OverlayWaveform;
  result?: OverlayResult | null;
  mac?: boolean;
}

/**
 * The HUD's words for a result. Short enough for the 248px result window;
 * `spokenResultText` gives screen readers the full sentence.
 */
export function resultText(result: OverlayResult | null, mac = isMacPlatform()): string {
  const paste = mac ? '⌘V' : 'Ctrl+V';
  switch (result) {
    case 'copied': return `Copied. Press ${paste} to paste`;
    case 'maybe-copied': return 'Maybe inserted · copied';
    case 'maybe-inserted': return 'Maybe inserted · check field';
    case 'unverified': return 'Not verified';
    case 'insert-failed': return 'Couldn’t insert';
    default: return 'Couldn’t transcribe';
  }
}

/** Full sentence for the live region (no width limit). */
export function spokenResultText(result: OverlayResult | null, mac = isMacPlatform()): string {
  const paste = mac ? 'Command V' : 'Control V';
  if (result === 'maybe-copied') return `May not have been inserted. The text was also copied; press ${paste} to paste.`;
  if (result === 'maybe-inserted') return 'May have been inserted. Check the field; nothing was copied.';
  if (result === 'unverified') return 'Sent to Terminal, not verified.';
  return resultText(result, mac);
}

const isResult = (w: OverlayWaveform) => w.startsWith('result-');

/**
 * Non-focusable desktop HUD (SPEC § HUD behavior rules). Listening: waveform
 * only. Transcribing: Option A (pulsing, shimmering lime→cyan bar row; slow
 * breathe under Reduce Motion). Results: a brief Copied / unverified / error.
 * One permanent role=status node announces "Transcribing" and results.
 */
export function OverlayWaveformView({ levels, waveform, result = null, mac = isMacPlatform() }: Props) {
  const text = isResult(waveform) ? resultText(result, mac) : '';
  const spoken = waveform === 'processing' ? 'Transcribing' : isResult(waveform) ? spokenResultText(result, mac) : '';
  const kind = waveform === 'result-copied' ? 'copied' : waveform === 'result-unverified' ? 'unverified' : 'failed';
  return (
    <>
      <div aria-atomic="true" className="sr-only" role="status">{spoken}</div>
      {isResult(waveform) ? (
        <div aria-hidden="true" className={`hud-result hud-result--${kind}`} data-waveform={waveform}>
          <Icon name={kind === 'copied' || result === 'maybe-copied' ? 'copy' : kind === 'unverified' ? 'info' : 'warn'} size={14} />
          <span>{text}</span>
        </div>
      ) : (
        <div className="recording recording--overlay" data-waveform={waveform}>
          {waveform === 'processing'
            ? <div aria-hidden="true" className="hud-transcribing"><i /></div>
            : <Waveform levels={levels} waveform={waveform} />}
        </div>
      )}
    </>
  );
}

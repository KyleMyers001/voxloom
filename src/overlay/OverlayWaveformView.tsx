import { Icon } from '../components/Icon';
import { Waveform } from '../components/Waveform';
import type { OverlayResult, OverlayWaveform } from '../services/shortcut/overlayVisibility';

interface Props {
  levels: readonly number[];
  waveform: OverlayWaveform;
  result?: OverlayResult | null;
}

const failureText: Record<Exclude<OverlayResult, 'copied'>, string> = {
  'insert-failed': 'Couldn’t insert',
  'transcribe-failed': 'Couldn’t transcribe',
};

/**
 * Non-focusable desktop HUD (SPEC § HUD behavior rules). Listening: waveform
 * only. Transcribing: Option A, an even bar row with a pulsing, shimmering
 * lime→cyan gradient (slow opacity breathe under Reduce Motion). Results:
 * only a brief Copied or short error; inserted/unverified never reach here.
 */
export function OverlayWaveformView({ levels, waveform, result = null }: Props) {
  if (waveform === 'result-copied' || waveform === 'result-failed') {
    const copied = waveform === 'result-copied';
    const text = copied ? 'Copied. Press ⌘V to paste' : failureText[result === 'insert-failed' ? 'insert-failed' : 'transcribe-failed'];
    return (
      <div className={`hud-result hud-result--${copied ? 'copied' : 'failed'}`} data-waveform={waveform} role="status">
        <Icon name={copied ? 'copy' : 'warn'} size={14} />
        <span>{text}</span>
      </div>
    );
  }
  return (
    <div className="recording recording--overlay" data-waveform={waveform}>
      {waveform === 'processing'
        ? <div aria-label="Transcribing" className="hud-transcribing" role="img"><i /></div>
        : <Waveform levels={levels} waveform={waveform} />}
    </div>
  );
}

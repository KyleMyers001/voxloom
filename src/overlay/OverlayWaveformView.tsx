import { Waveform } from "../components/Waveform";
import type { OverlayWaveform } from "../services/shortcut/overlayVisibility";

interface Props {
  levels: readonly number[];
  waveform: OverlayWaveform;
}

/** Non-focusable desktop overlay — its levels come from native capture. */
export function OverlayWaveformView({ levels, waveform }: Props) {
  return (
    <div className="recording recording--overlay" data-waveform={waveform}>
      <Waveform levels={levels} waveform={waveform} />
    </div>
  );
}

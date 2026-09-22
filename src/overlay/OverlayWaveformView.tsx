import type { OverlayWaveform } from "../services/shortcut/overlayVisibility";

const heights = [3, 7, 10, 5, 9, 4, 6, 11, 6, 9, 4, 8,
  5, 10, 4, 8, 11, 5, 7, 3, 9, 6, 8, 4];

interface Props {
  waveform: OverlayWaveform;
}

/** 24-segment level meter — reduced-motion handled via CSS. */
export function OverlayWaveformView({ waveform }: Props) {
  const dataWave =
    waveform === "processing" ? "speaking" : waveform;
  return (
    <div className="recording recording--overlay" data-waveform={dataWave}>
      <div
        aria-label={`${waveform} dictation waveform`}
        className="wave"
        role="img"
      >
        {heights.map((height, index) => (
          <i
            key={`${height}-${index}`}
            style={{
              "--delay": `${-20 - index * 29}ms`,
              "--h": `${height}px`,
            } as React.CSSProperties}
          />
        ))}
      </div>
    </div>
  );
}

import { useApp } from "../app/AppContext";

const heights = [3, 7, 10, 5, 9, 4, 6, 11, 6, 9, 4, 8,
  5, 10, 4, 8, 11, 5, 7, 3, 9, 6, 8, 4];

export function Waveform() {
  const { state } = useApp();
  const visible = state.dictation.kind === "listening" ||
    state.dictation.kind === "processing";
  if (!visible) return null;
  const waveform = state.dictation.kind === "listening"
    ? state.dictation.waveform
    : "speaking";
  return (
    <div className="recording" data-waveform={waveform}>
      <div
        aria-label={`${waveform} mock waveform`}
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

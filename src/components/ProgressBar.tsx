type Props = { label: string; value: number; caption?: string };

/** Determinate progress (0–100) with the brand gradient fill. */
export function ProgressBar({ label, value, caption }: Props) {
  const pct = Math.round(Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0)));
  return (
    <div className="prog">
      {caption ? <span>{caption}</span> : null}
      <div aria-label={label} aria-valuemax={100} aria-valuemin={0} aria-valuenow={pct} aria-valuetext={caption ?? `${pct}%`} className="bar" role="progressbar">
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

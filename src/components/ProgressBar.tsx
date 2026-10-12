type Props = { label: string; value: number | null; caption?: string };

/**
 * Progress with the brand gradient fill. `value` is 0–100; `null` is
 * indeterminate, which omits aria-valuenow (and valuemin/max) per ARIA.
 */
export function ProgressBar({ label, value, caption }: Props) {
  const indeterminate = value === null || !Number.isFinite(value);
  const pct = indeterminate ? 0 : Math.round(Math.min(100, Math.max(0, value)));
  const aria = indeterminate
    ? { 'aria-valuetext': caption }
    : { 'aria-valuemax': 100, 'aria-valuemin': 0, 'aria-valuenow': pct, 'aria-valuetext': caption ?? `${pct}%` };
  return (
    <div className="prog">
      {caption ? <span>{caption}</span> : null}
      <div aria-label={label} className="bar" data-indeterminate={indeterminate || undefined} role="progressbar" {...aria}>
        {indeterminate ? null : <i style={{ width: `${pct}%` }} />}
      </div>
    </div>
  );
}

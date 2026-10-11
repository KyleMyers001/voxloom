type Props = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Hide the visible label (still announced). */
  hideLabel?: boolean;
};

/** Toggle switch: a native button with role="switch" (Space/Enter toggle). */
export function Switch({ label, checked, onChange, disabled = false, hideLabel = false }: Props) {
  return (
    <button
      aria-checked={checked}
      aria-label={hideLabel ? label : undefined}
      className={checked ? 'switch on' : 'switch'}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <i aria-hidden="true" />
      {hideLabel ? null : <span className="switch__label">{label}</span>}
    </button>
  );
}

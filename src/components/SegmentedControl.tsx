import { useRef, type KeyboardEvent } from 'react';

export type SegmentOption<T extends string> = { value: T; label: string };

type Props<T extends string> = {
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  disabled?: boolean;
  /** Ids of a visible label / help text; aria-labelledby wins over label when given. */
  labelledBy?: string;
  describedBy?: string;
};

const step: Record<string, number> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };

/** Radiogroup with roving tabindex; arrows, Home and End move and select. */
export function SegmentedControl<T extends string>(
  { label, options, value, onChange, size = 'md', disabled = false, labelledBy, describedBy }: Props<T>,
) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // -1 when value isn't an option: nothing is checked, but the first option stays focusable.
  const current = options.findIndex((o) => o.value === value);
  const tabStop = current < 0 ? 0 : current;

  const onKeyDown = (event: KeyboardEvent) => {
    let next: number | undefined;
    if (event.key in step) {
      const from = current < 0 ? (step[event.key] > 0 ? -1 : 0) : current;
      next = (from + step[event.key] + options.length) % options.length;
    }
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      aria-describedby={describedBy}
      aria-disabled={disabled || undefined}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      className={size === 'sm' ? 'seg seg--sm' : 'seg'}
      onKeyDown={disabled ? undefined : onKeyDown}
      role="radiogroup"
    >
      {options.map((option, index) => (
        <button
          aria-checked={index === current}
          className={index === current ? 'seg__item on' : 'seg__item'}
          disabled={disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          ref={(el) => { refs.current[index] = el; }}
          role="radio"
          tabIndex={index === tabStop ? 0 : -1}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

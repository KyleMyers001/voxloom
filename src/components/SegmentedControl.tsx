import { useRef, type KeyboardEvent } from 'react';

export type SegmentOption<T extends string> = { value: T; label: string };

type Props<T extends string> = {
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  disabled?: boolean;
};

const step: Record<string, number> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };

/** Radiogroup with roving tabindex; arrows, Home and End move and select. */
export function SegmentedControl<T extends string>(
  { label, options, value, onChange, size = 'md', disabled = false }: Props<T>,
) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = Math.max(0, options.findIndex((o) => o.value === value));

  const onKeyDown = (event: KeyboardEvent) => {
    let next: number | undefined;
    if (event.key in step) next = (current + step[event.key] + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      aria-disabled={disabled || undefined}
      aria-label={label}
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
          tabIndex={index === current ? 0 : -1}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

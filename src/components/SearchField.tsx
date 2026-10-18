import { Icon } from './Icon';

type Props = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
};

/** Search input with a leading icon and an Escape-to-clear shortcut. */
export function SearchField({ label, value, onChange, placeholder }: Props) {
  return (
    <label className="search">
      <Icon name="search" size={14} />
      <input
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value) {
            event.preventDefault();
            onChange('');
          }
        }}
        placeholder={placeholder ?? label}
        type="search"
        value={value}
      />
    </label>
  );
}

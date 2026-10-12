import { useApp } from '../../app/AppContext';
import type { Appearance } from '../../domain/types';

const appearances: { label: string; value: Appearance }[] = [
  { label: 'Follow system', value: 'system' },
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
];

/** Appearance tab (A1): theme swatch cards. */
export function AppearanceTab() {
  const { settings, state } = useApp();
  return (
    <fieldset className="appearance-options">
      <legend>Theme</legend>
      {appearances.map(({ label, value }) => (
        <label className="appearance-option" key={value}>
          <input
            checked={state.settings.appearance === value}
            name="appearance"
            onChange={() => settings.update({ key: 'appearance', value })}
            type="radio"
            value={value}
          />
          <span>{label}</span>
          <span aria-hidden="true" className="appearance-swatch" data-preview={value}><i /><i /></span>
        </label>
      ))}
    </fieldset>
  );
}

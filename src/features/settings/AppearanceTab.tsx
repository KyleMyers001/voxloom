import { useApp } from '../../app/AppContext';
import { SegmentedControl } from '../../components/SegmentedControl';
import type { Appearance, TextSize } from '../../domain/types';

const appearances: { label: string; value: Appearance }[] = [
  { label: 'Follow system', value: 'system' },
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
];

const textSizeOptions: { label: string; value: TextSize }[] = [
  { label: 'Small', value: 'small' },
  { label: 'Default', value: 'default' },
  { label: 'Large', value: 'large' },
];

/** Appearance tab (A1): theme swatch cards, plus Text size (BUS-41). */
export function AppearanceTab() {
  const { settings, state } = useApp();
  return (
    <>
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
    <div className="settings-rows settings-rows--after-fieldset">
      <div className="frow">
        <span className="frow__label">
          <label id="settings-text-size-label">Text size</label>
          <small className="frow__help" id="settings-text-size-help">Doesn't change the recording indicator.</small>
        </span>
        <SegmentedControl
          describedBy="settings-text-size-help"
          label="Text size"
          labelledBy="settings-text-size-label"
          onChange={(value) => settings.update({ key: 'textSize', value })}
          options={textSizeOptions}
          size="sm"
          value={state.settings.textSize}
        />
      </div>
    </div>
    </>
  );
}

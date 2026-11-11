import type { AppAction } from '../../src/app/state';
import type { SettingsStore } from '../../src/services/contracts';

const validSetting: AppAction = {
  key: 'startAtLogin',
  now: Date.now(), type: 'set-setting',
  value: true,
};

const invalidSetting: AppAction = {
  key: 'startAtLogin',
  now: Date.now(), type: 'set-setting',
  // @ts-expect-error Boolean settings reject string values.
  value: 'yes',
};

void invalidSetting;
void validSetting;

declare const settings: SettingsStore;
settings.update({ key: 'startAtLogin', value: true });
// @ts-expect-error Settings service correlates keys and values.
settings.update({ key: 'startAtLogin', value: 'yes' });

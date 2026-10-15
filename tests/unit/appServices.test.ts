import { describe, expect, it, vi } from 'vitest';
import { initialOnboarding } from '../../src/domain/fixtures';
import {
  createDictionaryService,
  createHistoryService,
  createSettingsService,
  createSetupService,
} from '../../src/services/mock/appServices';

describe('mock application services', () => {
  it('maps dictionary and history operations to reducer actions', () => {
    const dispatch = vi.fn();
    const dictionary = createDictionaryService(dispatch);
    const history = createHistoryService(dispatch);
    dictionary.save('Vite', 'vite');
    dictionary.delete('Vite');
    history.delete('record-1');
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { editing: 'vite', type: 'save-word', word: 'Vite' },
      { type: 'delete-word', word: 'Vite' },
      { id: 'record-1', type: 'delete-record' },
    ]);
  });

  it('maps typed settings and setup operations to reducer actions', () => {
    const dispatch = vi.fn();
    const settings = createSettingsService(dispatch);
    const setup = createSetupService(dispatch);
    settings.update({ key: 'startAtLogin', value: true });
    setup.update({ holdTested: true });
    setup.reopen();
    setup.replace({ ...initialOnboarding, permissionDenied: true });
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { key: 'startAtLogin', now: expect.any(Number), type: 'set-setting', value: true },
      { changes: { holdTested: true }, type: 'update-onboarding' },
      { type: 'reopen-onboarding' },
      {
        type: 'set-onboarding',
        value: { ...initialOnboarding, permissionDenied: true },
      },
    ]);
  });
});

/// BUS-35: model-file messages carry no second Settings hint; missing keeps one.
import { describe, expect, it } from 'vitest';
import { errorText, MODEL_DAMAGED_MESSAGE, MODEL_READ_FAILED_MESSAGE } from '../../src/services/stt/useDogfoodCapture';
import { SttError } from '../../src/services/stt/types';

const err = (m: string) => new SttError('model-missing', m);

describe('errorText', () => {
  it('shows the damaged copy as is (native resolved_path and pre-check)', () => {
    expect(MODEL_DAMAGED_MESSAGE).toBe('Model file is damaged. Download it again in Settings.');
    expect(errorText(err(MODEL_DAMAGED_MESSAGE))).toBe(MODEL_DAMAGED_MESSAGE);
  });
  it('shows the unreadable copy as is', () => {
    const m = 'Couldn\'t open the model file. Try again, or download it again if this keeps happening.';
    expect(errorText(err(m))).toBe(m);
  });
  it('shows the read-failed copy as is (no doubled Settings hint)', () => {
    expect(MODEL_READ_FAILED_MESSAGE).toBe('Couldn\'t read the model file. Download it again in Settings.');
    expect(errorText(err(MODEL_READ_FAILED_MESSAGE))).toBe(MODEL_READ_FAILED_MESSAGE);
  });
  it('adds one short Settings hint to a missing model', () => {
    expect(errorText(err('Model `x` is not downloaded.'))).toBe(
      'Model `x` is not downloaded. Download the selected model in Settings first.',
    );
  });
});

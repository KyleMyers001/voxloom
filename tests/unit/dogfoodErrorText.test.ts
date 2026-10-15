/// BUS-77: model-file toasts carry no extra suffix; missing keeps a short one.
import { describe, expect, it } from 'vitest';
import { errorText } from '../../src/services/stt/useDogfoodCapture';
import { SttError } from '../../src/services/stt/types';

const err = (m: string) => new SttError('model-missing', m);

describe('errorText', () => {
  it('shows the damaged copy as is', () => {
    const m = 'Model file is damaged. Download it again in Settings.';
    expect(errorText(err(m))).toBe(m);
  });
  it('shows the unreadable copy as is', () => {
    const m = 'Couldn\'t open the model file. Try again, or download it again if this keeps happening.';
    expect(errorText(err(m))).toBe(m);
  });
  it('adds a short suffix to a missing model', () => {
    expect(errorText(err('Model `x` is not downloaded.'))).toBe(
      'Model `x` is not downloaded. Download the selected model in Settings first.',
    );
  });
});

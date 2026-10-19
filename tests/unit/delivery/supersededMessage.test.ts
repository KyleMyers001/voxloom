/** BUS-91: a superseded run's toast never points at Home's last transcript. */
import { describe, expect, it } from 'vitest';
import {
  MANUAL_RECOVERY_HINT, STALE_DELIVERY_DETAIL, SUPERSEDED_DELIVERY_MESSAGE,
  supersededDeliveryMessage,
} from '../../../src/services/delivery';

describe('supersededDeliveryMessage', () => {
  it('says a skipped delivery was replaced', () => {
    expect(supersededDeliveryMessage({ detail: STALE_DELIVERY_DETAIL, message: 'Failed' }))
      .toBe(SUPERSEDED_DELIVERY_MESSAGE);
  });

  it('keeps another outcome but swaps the last-transcript hint for History', () => {
    const message = `Failed — clipboard changed after write — ${MANUAL_RECOVERY_HINT}`;
    expect(supersededDeliveryMessage({ detail: 'conflict', message }))
      .toBe('Failed — clipboard changed after write — Its text is in History.');
    expect(supersededDeliveryMessage({ detail: null, message: 'Inserted into Notes' }))
      .toBe('Inserted into Notes');
  });

  it('the recovery hint says History keeps text this app session with retention off', () => {
    expect(MANUAL_RECOVERY_HINT).toMatch(/History/);
    expect(MANUAL_RECOVERY_HINT).toMatch(/retention off, History keeps it until you quit/);
    expect(MANUAL_RECOVERY_HINT).not.toMatch(/when retention is on/);
  });
});

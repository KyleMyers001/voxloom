import { describe, expect, it } from 'vitest';
import { validateCleanupOutput } from '../../../src/services/cleanup/validation';

// BUS-107 (Codex 4309897818): contraction expansion must not turn one spoken
// word into a dictionary join, nor hide a dictionary repair behind its suffix.
describe('contractions that expand to a dictionary word', () => {
  it.each([
    ['can\'t go', 'Can\'t go.'],
    ['can\'t go', 'Cannot go.'],
    ['can\'t go', 'Can not go.'],
    ['cannot go', 'Cannot go.'],
    ['cannot go', 'Can\'t go.'],
    ['we can not go', 'We cannot go.'],
    ['we can not go', 'We can\'t go.'],
  ])('accepts %s → %s with [cannot]', (raw, candidate) => {
    expect(validateCleanupOutput(raw, candidate, ['cannot'])).toBe(candidate);
  });

  it.each([
    ['can go', 'Cannot go.'],
    ['can\'t go', 'Can go.'],
    ['we can not go', 'We CANNOT go.'],
  ])('rejects %s → %s with [cannot]', (raw, candidate) => {
    expect(validateCleanupOutput(raw, candidate, ['cannot'])).toBeNull();
  });
});

describe('dictionary repairs inside a contraction', () => {
  it.each([
    ['voxlom\'ll ship', 'Voxloom\'ll ship.'],
    ['voxlom’ll ship', 'Voxloom’ll ship.'],
    ['voxlom\'ll ship', 'Voxlom\'ll ship.'],
    ['voxlom\'ll ship', 'Voxloom will ship.'],
    ['vox loom\'ll ship', 'Voxloom\'ll ship.'],
    ['voxlom isn\'t ready', 'Voxloom isn\'t ready.'],
  ])('accepts %s → %s with [Voxloom]', (raw, candidate) => {
    expect(validateCleanupOutput(raw, candidate, ['Voxloom'])).toBe(candidate);
  });

  it.each([
    ['voxlom\'ll ship', 'voxloom\'ll ship.'],
    ['voxlom\'ll ship', 'VOXLOOM\'ll ship.'],
    ['vox loom\'ll ship', 'voxloom\'ll ship.'],
    ['voxlom\'ll ship', 'Voxloom ship.'],
  ])('rejects %s → %s with [Voxloom]', (raw, candidate) => {
    expect(validateCleanupOutput(raw, candidate, ['Voxloom'])).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  validateCleanupOutput,
  wrapsWholeText,
} from '../../../src/services/cleanup/validation';

// BUS-16 PR 2c follow-ups from Code Reviewer and QA on #101.
describe('dictionary repairs keep inflection', () => {
  it.each([
    ['ship notions', 'Ship Notion.'],
    ['ship notion', 'Ship Notions.'],
    ['the motions passed', 'The Notion passed.'],
  ])('rejects %s → %s with [Notion]', (raw, candidate) => {
    expect(validateCleanupOutput(raw, candidate, ['Notion'])).toBeNull();
  });

  it.each([
    ['ship notions', 'Ship notions.'],
    ['please file the motion', 'Please file the Notion.'],
  ])('accepts %s → %s with [Notion]', (raw, candidate) => {
    expect(validateCleanupOutput(raw, candidate, ['Notion'])).toBe(candidate);
  });
});

describe('dictionary repairs use the dictionary casing', () => {
  it.each([
    ['send to Voxlom', 'Send to voxloom.'],
    ['send to Voxlom', 'Send to VOXLOOM.'],
    ['open vox loom', 'Open voxloom.'],
    ['send it to (Voxlom)', 'Send it to (voxloom).'],
  ])('rejects %s → %s with [Voxloom]', (raw, candidate) => {
    expect(validateCleanupOutput(raw, candidate, ['Voxloom'])).toBeNull();
  });

  it.each([
    ['send to Voxlom', 'Send to Voxloom.'],
    ['send to Voxlom', 'Send to Voxlom.'],
    ['open vox loom', 'Open Voxloom.'],
    ['open vox loom', 'Open vox loom.'],
    ['send it to (vox loom)', 'Send it to (Voxloom).'],
  ])('accepts %s → %s with [Voxloom]', (raw, candidate) => {
    expect(validateCleanupOutput(raw, candidate, ['Voxloom'])).toBe(candidate);
  });

  it('uses the first spelling of a case-insensitive duplicate, as the prompt does', () => {
    expect(validateCleanupOutput('send to Voxlom', 'Send to Voxloom.', [' Voxloom ', 'voxloom']))
      .toBe('Send to Voxloom.');
    expect(validateCleanupOutput('send to Voxlom', 'Send to voxloom.', [' Voxloom ', 'voxloom']))
      .toBeNull();
  });
});

describe('mark anchors', () => {
  it('rejects a mark that moves past a content word with no attachment change', () => {
    // Only the anchor differs: `#` touches no word on either side.
    expect(validateCleanupOutput('a # b c', 'A b # c.')).toBeNull();
    expect(validateCleanupOutput('a # b c', 'A # b c.')).toBe('A # b c.');
  });
});

describe('wrapsWholeText', () => {
  it.each([
    ['"hi"', true],
    ['“Hello there.”', true],
    ['"done".', true],
    ['um "hello there"', true],
    ['Uh, "hello there"', true],
    ['the "plan"', false],
    ['she said "hi"', false],
    ['"hi" there', false],
    ['no quotes', false],
  ])('%s → %s', (text, expected) => {
    expect(wrapsWholeText(text)).toBe(expected);
  });

  it('rejects output that newly wraps the whole text in a quotation', () => {
    // Marks and content agree; only the whole-text check differs.
    expect(validateCleanupOutput('the "plan"', '"Plan."')).toBeNull();
    expect(validateCleanupOutput('the "plan"', 'The "plan".')).toBe('The "plan".');
  });
});

describe('dictated reasoning markers are not model leakage', () => {
  it.each([
    ['my reasoning: it is cheap', 'My reasoning: it is cheap.'],
    ['close the </think> tag', 'Close the </think> tag.'],
    ['add <think> and </think> tags', 'Add <think> and </think> tags.'],
  ])('accepts dictated %s', (raw, candidate) => {
    expect(validateCleanupOutput(raw, candidate)).toBe(candidate);
  });

  it.each([
    ['send the report', '<think>ok</think> Send the report.'],
    ['send the report', 'Reasoning: send the report.'],
    ['close the </think> tag', '</think> Close the </think> tag.'],
    ['my reasoning: it is cheap', 'Reasoning: my reasoning: it is cheap.'],
    // Only the marker check catches this one: same words, a new `reasoning:`.
    ['reasoning send the report', 'Reasoning: send the report.'],
  ])('rejects new markers: %s → %s', (raw, candidate) => {
    expect(validateCleanupOutput(raw, candidate)).toBeNull();
  });
});

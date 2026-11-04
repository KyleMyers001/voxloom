// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { entryChunks } from '../../../src/services/dictionary/chunks';

describe('entryChunks', () => {
  it.each([
    ['ChatGPT', ['Chat', 'GPT']],
    ['Chat GPT', ['Chat', 'GPT']],
    ['chat-gpt', ['chat', 'gpt']],
    ['GPT4', ['GPT', '4']],
    ['GPT-3.5', ['GPT', '3.5']],
    ['Web3', ['Web', '3']],
    ['OpenAI', ['Open', 'AI']],
    ['GitHub', ['Git', 'Hub']],
    ['macOS', ['mac', 'OS']],
    ['Voxloom', ['Voxloom']],
    ['skyloom', ['skyloom']],
    ['Node.js', ['Node.js']],
    ['Éclair', ['Éclair']],
    ['ÉcoleNormale', ['École', 'Normale']],
  ])('splits %s', (entry, chunks) => {
    expect(entryChunks(entry)).toEqual(chunks);
  });

  it('keeps a lone lowercase letter with the next chunk', () => {
    expect(entryChunks('iPhone')).toEqual(['iPhone']);
    expect(entryChunks('eBay')).toEqual(['eBay']);
    expect(entryChunks('iOS')).toEqual(['iOS']);
    expect(entryChunks('i Phone')).toEqual(['i', 'Phone']);
  });

  it('returns nothing for blank or separator-only entries', () => {
    expect(entryChunks('')).toEqual([]);
    expect(entryChunks('  ')).toEqual([]);
    expect(entryChunks(' - ')).toEqual([]);
  });

  it('normalises to NFC', () => {
    expect(entryChunks('E\u0301milie')).toEqual(['\u00c9milie']);
  });
});

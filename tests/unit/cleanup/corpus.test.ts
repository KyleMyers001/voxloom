import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { WritingStyle } from '../../../src/domain/types';
import {
  buildCleanupPrompt,
  snapshotDictionary,
} from '../../../src/services/cleanup/prompt';
import { validateCleanupOutput } from '../../../src/services/cleanup/validation';

interface Candidate {
  acceptWhen: string[];
  repeat?: number;
  text: string;
}
interface Case {
  candidates: Candidate[];
  categories: string[];
  dictionary: string[];
  id: string;
  promptReason?: string;
  rawText: string;
  repeat?: number;
}
const corpus: { cases: Case[]; version: number } = JSON.parse(readFileSync(
  'tests/fixtures/cleanup-corpus.json', 'utf8',
));
const styles: WritingStyle[] = ['casual', 'formal', 'very-casual'];

describe('synthetic cleanup corpus (not model quality evidence)', () => {
  it('has stable unique IDs and covers the required contrasts', () => {
    expect(corpus.version).toBe(1);
    expect(new Set(corpus.cases.map(({ id }) => id)).size).toBe(corpus.cases.length);
    const categories = new Set(corpus.cases.flatMap((item) => item.categories));
    for (const category of [
      'punctuation', 'fillers', 'paragraphs', 'pronouns', 'negation',
      'corrections', 'names', 'commands', 'flags', 'paths', 'urls',
      'numbers', 'quoted-instructions', 'unicode', 'long-inputs',
      'repetition', 'adversarial-answers', 'dictionary', 'articles',
      'special-characters',
    ]) expect(categories.has(category), category).toBe(true);
  });

  for (const item of corpus.cases) {
    for (const style of styles) {
      for (const mode of ['off', 'on']) {
        it(`${item.id} / ${style} / dictionary ${mode}`, () => {
          const rawText = item.rawText.repeat(item.repeat ?? 1);
          const dictionary = snapshotDictionary(mode === 'on' ? item.dictionary : []);
          const build = () => buildCleanupPrompt({ dictionary, rawText, style });
          if (item.promptReason) {
            expect(item.promptReason).toBe('context-overflow');
            expect(build).toThrow(/16000 UTF-8 bytes/);
          } else {
            const prompt = build();
            expect(JSON.parse(prompt.split('\n').at(-1)!)).toEqual({
              canonicalSpellings: dictionary, transcript: rawText,
            });
            expect(item.candidates.some((candidate) => candidate.acceptWhen.includes(mode)))
              .toBe(true);
            expect(item.candidates.some((candidate) => !candidate.acceptWhen.length)).toBe(true);
          }
          for (const candidate of item.candidates) {
            const text = candidate.text.repeat(candidate.repeat ?? 1);
            expect(validateCleanupOutput(rawText, text, dictionary), text.slice(0, 80))
              .toBe(candidate.acceptWhen.includes(mode) ? text.trim() : null);
          }
        });
      }
    }
  }
});

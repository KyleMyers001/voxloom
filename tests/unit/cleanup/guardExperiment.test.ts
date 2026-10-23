import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { snapshotDictionary } from '../../../src/services/cleanup/prompt';
import { validateCleanupOutput } from '../../../src/services/cleanup/validation';

// Replays the BUS-16 cleanup guard experiment (docs/evidence/guard-experiment.md)
// through the real validateCleanupOutput. The outputs are recorded Qwen3
// worker replies (Linux CPU, greedy), so no model runs here. A change to a
// recorded outcome below is a guard behaviour change: look at it, don't just
// update the list.

const dir = 'tests/fixtures/guard-exp/';
interface Item { dictionary: string[]; id: string; raw: string }
interface Output { id: string; model: string; prompt: string; status: string; text: string }
interface Stress { cand: string; dict: string[]; label: 'bad' | 'good'; raw: string }
const read = (name: string) => readFileSync(dir + name, 'utf8');
const corpus: Item[] = JSON.parse(read('corpus.json'));
const byId = new Map(corpus.map((item) => [item.id, item]));
const outputs: Output[] = read('outputs.jsonl').trim().split('\n').map((line) => JSON.parse(line));
const stress: Stress[] = JSON.parse(read('stress.json'));

function verdict(output: Output): string | null {
  const item = byId.get(output.id)!;
  if (output.status !== 'ok') return null;
  return validateCleanupOutput(item.raw, output.text, snapshotDictionary(item.dictionary));
}
const group = (model: string, prompt: string) =>
  outputs.filter((output) => output.model === model && output.prompt === prompt);

// Rejected item IDs per model and prompt on today's guard (accepted = 50 - rejected).
const rejected: Record<string, string[]> = {
  '0.6b/app': ['mh-their', 'mh-wright', 'dict-voxloom-fox', 'dict-tauri-tory', 'dict-qwen-queen',
    'dict-sophie', 'dict-jira', 'dict-stupidjargon-onedit', 'num-mishear', 'ctl-3', 'ctl-5'],
  '0.6b/loose': ['dictated-60w', 'mh-wright', 'mh-mail', 'mh-cash', 'dict-voxloom-fox', 'dict-tauri-tory',
    'dict-qwen-queen', 'dict-qwen-when', 'dict-sophie', 'dict-stupidjargon-onedit', 'neg-dont-merge',
    'neg-never', 'num-time', 'num-words', 'num-mishear', 'ctl-1', 'ctl-2', 'ctl-3', 'ctl-5'],
  '1.7b/app': ['mh-wright', 'mh-mail', 'num-amount', 'num-mishear', 'ctl-3', 'ctl-4', 'ctl-5'],
  '1.7b/loose': ['mh-wright', 'mh-mail', 'num-amount', 'num-mishear', 'ctl-3', 'ctl-5'],
};

describe('guard experiment fixtures', () => {
  it('has the recorded shape', () => {
    expect(corpus).toHaveLength(50);
    expect(byId.size).toBe(50);
    expect(outputs).toHaveLength(200);
    expect(outputs.every((output) => byId.has(output.id))).toBe(true);
    expect(stress.filter(({ label }) => label === 'good')).toHaveLength(20);
    expect(stress.filter(({ label }) => label === 'bad')).toHaveLength(15);
    for (const key of Object.keys(rejected)) {
      const [model, prompt] = key.split('/');
      expect(group(model, prompt), key).toHaveLength(50);
    }
  });

  describe('recorded worker outputs', () => {
    it.each(Object.entries(rejected))('%s: the rejected set is unchanged', (key, ids) => {
      const [model, prompt] = key.split('/');
      const rejectedNow = group(model, prompt).filter((output) => verdict(output) === null)
        .map((output) => output.id);
      expect(rejectedNow).toEqual(ids);
    });

    it('accepts 39, 31, 43 and 44 of 50 (the A2 column of the report)', () => {
      const counts = Object.keys(rejected).map((key) => 50 - rejected[key].length);
      expect(counts).toEqual([39, 31, 43, 44]);
    });

    // QA #122: before it, these 8 app-prompt outputs were rejected (33 and 41
    // of 50 accepted). The guard now accepts them, and every one is a
    // no-change, quote-wrapped or dropped-Okay output with no word altered.
    it.each([
      ['0.6b', 'dictated-jargon'], ['0.6b', 'dictated-60w'], ['0.6b', 'dictated-60w-casual'],
      ['0.6b', 'dict-whisper'], ['0.6b', 'neg-not-sure'], ['0.6b', 'neg-cant'],
      ['1.7b', 'dictated-60w'], ['1.7b', 'dictated-60w-casual'],
    ])('%s app %s: accepted since #122', (model, id) => {
      const output = group(model, 'app').find((candidate) => candidate.id === id)!;
      expect(verdict(output)).not.toBeNull();
    });

    it('delivers the quote-wrapped jargon sentence unchanged and unquoted', () => {
      const output = group('0.6b', 'app').find(({ id }) => id === 'dictated-jargon')!;
      expect(output.text.startsWith('"')).toBe(true);
      expect(verdict(output)).toBe(byId.get('dictated-jargon')!.raw);
    });

    it('delivers the 60-word dictation without its final Okay', () => {
      const output = group('0.6b', 'app').find(({ id }) => id === 'dictated-60w')!;
      const raw = byId.get('dictated-60w')!.raw;
      expect(raw.endsWith(' Okay.')).toBe(true);
      expect(verdict(output)).toBe(raw.slice(0, -' Okay.'.length));
    });

    it('never accepts a meaning change the experiment did not intend (smirk stays smirk)', () => {
      const smirk = group('0.6b', 'app').find(({ id }) => id === 'dictated-smirk')!;
      expect(verdict(smirk)).toBe(byId.get('dictated-smirk')!.raw);
    });
  });

  describe('hand-written stress candidates', () => {
    it('accepts none of the 15 meaning-changing corruptions', () => {
      const bad = stress.filter(({ label }) => label === 'bad');
      expect(bad.filter((item) => validateCleanupOutput(item.raw, item.cand, snapshotDictionary(item.dict)))
        .map(({ cand }) => cand)).toEqual([]);
    });

    it('accepts exactly the two StupidJargon fixes of the 20 good ones', () => {
      const good = stress.filter(({ label }) => label === 'good');
      expect(good.filter((item) => validateCleanupOutput(item.raw, item.cand, snapshotDictionary(item.dict)))
        .map(({ cand }) => cand)).toEqual([
        'You\'re making a lot of progress on the StupidJargon app.',
        'You are making a lot of progress on the StupidJargon app.',
      ]);
    });
  });

  // The three differences QA #124 recorded against the #122 probe set (104 of
  // 107 identical). The first two are fixes; the third fails safe.
  describe('#124 intended differences', () => {
    it('drops an Okay followed by a Unicode ellipsis', () => {
      expect(validateCleanupOutput('Ship it. Okay…', 'Ship it.')).toBe('Ship it.');
    });

    it('unwraps "text". and moves the period inside', () => {
      expect(validateCleanupOutput('send the report today', '"Send the report today".'))
        .toBe('Send the report today.');
    });

    it('rejects a padded dictionary term passed directly, but accepts it through snapshotDictionary', () => {
      const raw = 'we use whisperkit here';
      const candidate = 'We use WhisperKit here.';
      expect(validateCleanupOutput(raw, candidate, ['  WhisperKit '])).toBeNull();
      expect(validateCleanupOutput(raw, candidate, snapshotDictionary(['  WhisperKit '])))
        .toBe(candidate);
    });
  });
});

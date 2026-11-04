// @vitest-environment node
// BUS-138 PR B: "also heard as". An alias is replaced by its word's saved
// spelling with the same matcher as the words themselves.
import { describe, expect, it } from 'vitest';

import { normalizeAliases } from '../../../src/services/dictionary/aliases';
import { replaceDictionaryTerms } from '../../../src/services/dictionary/replace';

const WORDS = ['Kubernetes', 'Skyloom', 'Voxloom'];
const ALIASES = {
  Kubernetes: ['cooper netties', 'kuber netties'],
  Skyloom: ['sky loom'],
  Voxloom: ['box loom', 'voks loom'],
};

const fix = (text: string, words: string[] = WORDS, aliases: Record<string, string[]> = ALIASES) =>
  replaceDictionaryTerms(text, words, aliases);

describe('aliases are replaced by the saved spelling', () => {
  it('rewrites a different-letters alias', () => {
    expect(fix('i pushed box loom to github')).toBe('i pushed Voxloom to github');
    expect(fix('we deploy on cooper netties')).toBe('we deploy on Kubernetes');
  });

  it('matches the alias in any case and with a space, a hyphen or no space', () => {
    for (const heard of ['box loom', 'Box Loom', 'BOX LOOM', 'box-loom', 'boxloom', 'Box  Loom']) {
      expect(fix(`open ${heard} now`), heard).toBe('open Voxloom now');
    }
  });

  it('handles both aliases and the word in one text', () => {
    expect(fix('box loom, voks loom and voxloom')).toBe('Voxloom, Voxloom and Voxloom');
  });

  it('works without aliases exactly as before', () => {
    expect(replaceDictionaryTerms('open box loom and voxloom', WORDS))
      .toBe('open box loom and Voxloom');
    expect(replaceDictionaryTerms('open box loom and voxloom', WORDS, {}))
      .toBe('open box loom and Voxloom');
  });

  it('returns the same text when nothing matches', () => {
    const text = 'nothing to see here';
    expect(fix(text)).toBe(text);
  });

  it('ignores aliases for a word that is not in the list', () => {
    expect(replaceDictionaryTerms('box loom', ['Postgres'], ALIASES)).toBe('box loom');
  });

  it('a word that is a plain common word still takes aliases', () => {
    // "Will" alone is never forced onto "will", but "wil" is stated as heard-as.
    expect(replaceDictionaryTerms('the wil is strong', ['Will'], { Will: ['wil'] }))
      .toBe('the Will is strong');
    expect(replaceDictionaryTerms('the will is strong', ['Will'], { Will: ['wil'] }))
      .toBe('the will is strong');
  });
});

describe('an alias with the same letters as its word, spaced differently', () => {
  it('matches the engine splitting a compound', () => {
    expect(replaceDictionaryTerms('i pushed vox loom and Vox-Loom', ['Voxloom'], { Voxloom: ['vox loom'] }))
      .toBe('i pushed Voxloom and Voxloom');
  });

  it('without the alias the word does not match a split compound', () => {
    expect(replaceDictionaryTerms('i pushed vox loom', ['Voxloom'])).toBe('i pushed vox loom');
  });

  it('another word with the same letters still wins over the alias', () => {
    expect(replaceDictionaryTerms('vox loom', ['VoxLoom', 'Voxloom'], { Voxloom: ['vox loom'] })).toBe('VoxLoom');
  });

  it('a hand-edited alias on the wrong word with the same letters is dropped', () => {
    expect(replaceDictionaryTerms('post gres', ['Postgres', 'Voxloom'], { Voxloom: ['post gres'] })).toBe('post gres');
  });
});

describe('the same boundaries and rules as the words', () => {
  it('only matches whole words', () => {
    expect(fix('unbox loomer and box loomy')).toBe('unbox loomer and box loomy');
    expect(fix('box loom2 and box_loom')).toBe('box loom2 and box_loom');
  });

  it('keeps punctuation and handles line starts and ends', () => {
    expect(fix('box loom, (box loom) "box loom" box loom!\nbox loom'))
      .toBe('Voxloom, (Voxloom) "Voxloom" Voxloom!\nVoxloom');
  });

  it('never joins across a newline or comma', () => {
    expect(fix('box\nloom and box, loom')).toBe('box\nloom and box, loom');
  });

  it('leaves code-like text alone', () => {
    expect(fix('src/box loom and box loom.app and box loom/x and a box loom.')).toBe(
      'src/box loom and box loom.app and box loom/x and a Voxloom.',
    );
    expect(fix('npm run box loom')).toBe('npm run Voxloom');
  });

  it('keeps a possessive and refuses a start after an inside-word apostrophe', () => {
    expect(fix('box loom\'s menu and box loom\u2019s icon')).toBe('Voxloom\'s menu and Voxloom\u2019s icon');
    expect(fix('l\'box loom and we\'box loom')).toBe('l\'box loom and we\'box loom');
    expect(fix('\'box loom\' ok')).toBe('\'Voxloom\' ok');
  });

  it('prefers the longest match, alias or word', () => {
    const aliases = { 'Vox Loom Pro': ['box loom pro'], Voxloom: ['box loom'] };
    expect(fix('box loom pro and box loom', ['Vox Loom Pro', 'Voxloom'], aliases))
      .toBe('Vox Loom Pro and Voxloom');
  });

  it('a word wins over an alias with the same spelling', () => {
    expect(replaceDictionaryTerms('apple pie', ['Apple Pie', 'Pie'], { Pie: ['apple pie'] }))
      .toBe('Apple Pie');
  });

  it('with two aliases on one spelling, the first word in the list wins', () => {
    expect(replaceDictionaryTerms('a b', ['One', 'Two'], { One: ['a b'], Two: ['a b'] })).toBe('One');
  });

  it('replaces an alias that holds another entry\'s word, longest first', () => {
    expect(fix('say box loom', ['Loom', 'Voxloom'], { Voxloom: ['box loom'] })).toBe('say Voxloom');
    expect(fix('say loom', ['Loom', 'Voxloom'], { Voxloom: ['box loom'] })).toBe('say Loom');
  });

  it('a Unicode alias with a different casing and accents works', () => {
    expect(replaceDictionaryTerms('emilie est la', ['Émilie'], { Émilie: ['emilie'] })).toBe('Émilie est la');
  });

  it('skips an unusable alias instead of growing text', () => {
    const bad = { Voxloom: ['--box', 'box--loom', 'sky'] };
    expect(replaceDictionaryTerms('--box and box loom and sky', ['Voxloom'], bad))
      .toBe('--box and box loom and sky');
  });

  it('skips a single common word alias even if a hand-edited file has one', () => {
    expect(replaceDictionaryTerms('the sky is blue', ['Skyloom'], { Skyloom: ['sky'] }))
      .toBe('the sky is blue');
  });
});

describe('a chain through other entries settles', () => {
  it('fixes an alias next to another entry in the same text', () => {
    const words = ['Voxloom Pro', 'Voxloom'];
    const aliases = { Voxloom: ['box loom'] };
    expect(replaceDictionaryTerms('box loom pro', words, aliases)).toBe('Voxloom Pro');
  });

  // Each step's output plus the next words is another alias:
  // aa -> "Foo bar", "foo bar baz" -> Zed, "zed q" -> Yak, "yak r" -> Wolf.
  const chainWords = ['Foo bar', 'Zed', 'Yak', 'Wolf'];
  const chain = {
    'Foo bar': ['aa'],
    Wolf: ['yak r'],
    Yak: ['zed q'],
    Zed: ['foo bar baz'],
  };

  it('settles a chain of three changing passes', () => {
    const once = replaceDictionaryTerms('aa baz q', chainWords, chain);
    expect(once).toBe('Yak');
    expect(replaceDictionaryTerms(once, chainWords, chain)).toBe(once);
  });

  it('fails closed on a fourth changing pass: the input comes back unchanged', () => {
    const text = 'aa baz q r and voxloom';
    expect(replaceDictionaryTerms(text, [...chainWords, 'Voxloom'], chain)).toBe(text);
  });

  it('does not loop: an alias that is another entry\'s word is dropped, words win', () => {
    expect(normalizeAliases({ Aa: ['bb'], Bb: ['aa'] }, ['Aa', 'Bb'])).toEqual({});
    expect(replaceDictionaryTerms('aa bb', ['Aa', 'Bb'], { Aa: ['bb'], Bb: ['aa'] })).toBe('Aa Bb');
  });
});

describe('running it twice gives the same text as once', () => {
  const words = ['Voxloom', 'Voxloom Pro', 'Kubernetes', 'Skyloom', 'GPT-4', 'ChatGPT', 'AskChat', 'iPhone', 'Émilie', 'Tauri'];
  const aliases = {
    ChatGPT: ['chat jeepee', 'chat g p t'],
    iPhone: ['eye phone'],
    Kubernetes: ['cooper netties', 'kuber netties'],
    Skyloom: ['sky loom', 'skylum'],
    Tauri: ['tory', 'tau ree', 'the tauri'],
    Voxloom: ['box loom', 'voks loom', 'voks loom pro x'],
    'Voxloom Pro': ['box loom pro'],
    Émilie: ['emily s'],
  };
  const vocabulary = [
    'box', 'loom', 'vox', 'pro', 'box loom', 'Box-Loom', 'boxloom', 'cooper', 'netties', 'kuber netties',
    'sky', 'sky loom', 'skylum', 'chat', 'gpt', 'jeepee', 'chat jeepee', 'g p t', 'eye phone', 'tory',
    'tau ree', 'the', 'tauri', 'voxloom', 'voxloom pro', 'box loom pro', 'ask', 'chatgpt', 'askchat',
    ',', '.', '-', '\'s', 'don\'t', 'l\'box loom', '/', 'src/box loom', 'box loom.app', ':', '@', '=',
    'x', 'voks loom pro x', 'emily s', 'émilie', '--box', 'a-', '\n', '\u2019', 'I', 'it',
  ];

  it('3000 generated sentences', () => {
    let seed = 11;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let run = 0; run < 3000; run += 1) {
      const length = 3 + Math.floor(next() * 14);
      const text = Array.from({ length }, () =>
        vocabulary[Math.floor(next() * vocabulary.length)]).join(next() < 0.8 ? ' ' : '');
      const once = replaceDictionaryTerms(text, words, aliases);
      expect(replaceDictionaryTerms(once, words, aliases), text).toBe(once);
    }
  });

  it('exhaustive pairs of vocabulary items', () => {
    for (const first of vocabulary) {
      for (const second of vocabulary) {
        for (const joiner of [' ', '']) {
          const text = `${first}${joiner}${second}`;
          const once = replaceDictionaryTerms(text, words, aliases);
          expect(replaceDictionaryTerms(once, words, aliases), text).toBe(once);
        }
      }
    }
  });

  it('random alias tables over random sentences (normalised first, as the app does)', () => {
    let seed = 5;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pieces = ['a', 'b', 'ab', 'ba', 'a b', 'b a', 'x', 'x y', 'y', 'ax', 'xa', 'aa b', 'b-a'];
    const pick = () => pieces[Math.floor(next() * pieces.length)];
    for (let run = 0; run < 1500; run += 1) {
      const randomWords = Array.from({ length: 1 + Math.floor(next() * 4) }, pick)
        .map((piece) => (next() < 0.5 ? piece.toUpperCase() : piece));
      const raw: Record<string, string[]> = {};
      for (const word of randomWords) raw[word] = Array.from({ length: 1 + Math.floor(next() * 3) }, pick);
      const table = normalizeAliases(raw, randomWords);
      const text = Array.from({ length: 2 + Math.floor(next() * 8) }, pick).join(' ');
      const once = replaceDictionaryTerms(text, randomWords, table);
      expect(replaceDictionaryTerms(once, randomWords, table), JSON.stringify({ randomWords, table, text })).toBe(once);
    }
  });

  it('an empty alias table gives byte-identical output to words alone', () => {
    let seed = 3;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let run = 0; run < 1000; run += 1) {
      const text = Array.from({ length: 6 }, () => vocabulary[Math.floor(next() * vocabulary.length)]).join(' ');
      expect(replaceDictionaryTerms(text, words, {})).toBe(replaceDictionaryTerms(text, words));
      expect(replaceDictionaryTerms(text, words, undefined)).toBe(replaceDictionaryTerms(text, words));
    }
  });
});

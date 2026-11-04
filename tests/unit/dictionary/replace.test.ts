// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { replaceDictionaryTerms } from '../../../src/services/dictionary/replace';

const fix = (text: string, words: string[]) =>
  replaceDictionaryTerms(text, words);

describe('whole-word, case-insensitive replacement', () => {
  it('writes the entry exactly as saved', () => {
    expect(fix('ask voxloom about it', ['Voxloom'])).toBe('ask Voxloom about it');
    expect(fix('ask VOXLOOM about it', ['Voxloom'])).toBe('ask Voxloom about it');
    expect(fix('use kubernetes today', ['kubernetes'])).toBe('use kubernetes today');
    expect(fix('Use Kubernetes today', ['kubernetes'])).toBe('Use kubernetes today');
  });

  it('only replaces whole words', () => {
    expect(fix('voxloomer and avoxloom', ['Voxloom'])).toBe('voxloomer and avoxloom');
    expect(fix('voxloom2 and voxloom_x', ['Voxloom'])).toBe('voxloom2 and voxloom_x');
  });

  it('handles punctuation, quotes and line starts and ends', () => {
    expect(fix('voxloom, voxloom. (voxloom) "voxloom" voxloom!', ['Voxloom']))
      .toBe('Voxloom, Voxloom. (Voxloom) "Voxloom" Voxloom!');
    expect(fix('voxloom\nvoxloom', ['Voxloom'])).toBe('Voxloom\nVoxloom');
  });

  it('treats an inside-word apostrophe as part of the word, so a possessive is not matched', () => {
    expect(fix('voxloom\'s menu and voxloom\u2019s icon', ['Voxloom']))
      .toBe('voxloom\'s menu and voxloom\u2019s icon');
  });

  it('does not split contractions', () => {
    expect(fix('don\'t stop, don\'t', ['Don'])).toBe('don\'t stop, don\'t');
  });

  it('does not touch a plural or other suffix', () => {
    expect(fix('two voxlooms', ['Voxloom'])).toBe('two voxlooms');
  });

  it('returns the same text when nothing matches', () => {
    const text = 'nothing to see here';
    expect(fix(text, ['Voxloom'])).toBe(text);
  });
});

describe('phrases, spacing and hyphens', () => {
  it.each([
    'chat gpt', 'Chat GPT', 'chat-gpt', 'CHAT GPT', 'chatgpt', 'chat  gpt',
  ])('turns "%s" into ChatGPT', (heard) => {
    expect(fix(`ask ${heard} now`, ['ChatGPT'])).toBe('ask ChatGPT now');
  });

  it('accepts the same variants for an entry typed with a space', () => {
    expect(fix('ask chatgpt now', ['Chat GPT'])).toBe('ask Chat GPT now');
    expect(fix('ask chat-gpt now', ['Chat GPT'])).toBe('ask Chat GPT now');
  });

  it('splits letter-digit changes into chunks', () => {
    expect(fix('gpt 4 and gpt-4 and gpt4', ['GPT4'])).toBe('GPT4 and GPT4 and GPT4');
    expect(fix('use gpt-3.5 please', ['GPT-3.5'])).toBe('use GPT-3.5 please');
    expect(fix('use gpt 3.5 please', ['GPT-3.5'])).toBe('use GPT-3.5 please');
  });

  it('handles multi-word entries', () => {
    expect(fix('in new york city today', ['New York City']))
      .toBe('in New York City today');
  });

  it('does not match across a comma or other punctuation', () => {
    expect(fix('chat, gpt', ['ChatGPT'])).toBe('chat, gpt');
    expect(fix('chat. gpt', ['ChatGPT'])).toBe('chat. gpt');
    expect(fix('chat\ngpt', ['ChatGPT'])).toBe('chat\ngpt');
    expect(fix('chat - gpt', ['ChatGPT'])).toBe('chat - gpt');
  });

  it('keeps a lone lowercase letter attached to its word (iPhone)', () => {
    expect(fix('buy an iphone', ['iPhone'])).toBe('buy an iPhone');
    expect(fix('then i phone him', ['iPhone'])).toBe('then i phone him');
  });

  it('matches entries made of symbols and escapes regex characters', () => {
    expect(fix('write node.js and nodexjs', ['Node.js'])).toBe('write Node.js and nodexjs');
    expect(fix('a c++ b', ['C++'])).toBe('a C++ b');
    expect(fix('x (a|b) y', ['(A|B)'])).toBe('x (A|B) y');
  });
});

describe('Unicode', () => {
  it('matches accented and non-Latin entries', () => {
    expect(fix('hello éclair', ['Éclair'])).toBe('hello Éclair');
    expect(fix('chez café et café', ['Café'])).toBe('chez Café et Café');
    expect(fix('это москва', ['Москва'])).toBe('это Москва');
  });

  it('normalises to NFC before matching', () => {
    const decomposed = 'hello e\u0301milie';
    expect(fix(decomposed, ['\u00c9milie'])).toBe('hello \u00c9milie');
    expect(fix('hello \u00e9milie', ['E\u0301milie'])).toBe('hello \u00c9milie');
  });

  it('does not match a word that continues with a combining mark', () => {
    expect(fix('cafe\u0301 here', ['Cafe'])).toBe('cafe\u0301 here');
  });

  it('keeps untouched text byte-for-byte when nothing changes', () => {
    const decomposed = 'caf\u0065\u0301 time';
    expect(fix(decomposed, ['Voxloom'])).toBe(decomposed);
  });
});

describe('longest match and single pass', () => {
  it('prefers the longer entry at the same position', () => {
    const words = ['New York', 'New York City', 'York'];
    expect(fix('visit new york city', words)).toBe('visit New York City');
    expect(fix('visit new york', words)).toBe('visit New York');
    expect(fix('visit york', words)).toBe('visit York');
  });

  it('does not chain one replacement into another', () => {
    // After "New York" is fixed, "York City" must not claim the same words.
    expect(fix('in new york city', ['New York', 'York City']))
      .toBe('in New York city');
    const words = ['ab cd', 'cd ef'];
    expect(fix('ab cd ef', words)).toBe('ab cd ef');
    expect(fix('AB CD EF', words)).toBe('ab cd EF');
  });

  it('applies several different entries in one text', () => {
    expect(fix('voxloom uses chat gpt and skyloom', ['Voxloom', 'ChatGPT', 'Skyloom']))
      .toBe('Voxloom uses ChatGPT and Skyloom');
  });

  it('uses the first entry when two entries collapse to one key', () => {
    expect(fix('chat gpt', ['Chat GPT', 'ChatGPT'])).toBe('Chat GPT');
  });
});

describe('common-word guard', () => {
  it.each(['Will', 'Sky', 'Mark', 'Bill', 'Grace', 'May', 'IT', 'Amber', 'Chase', 'Ray', 'will'])(
    'leaves every use of a plain common word alone (%s)',
    (entry) => {
      const text = 'it will be a clear sky, mark my words. May I? Bill it.';
      expect(fix(text, [entry])).toBe(text);
    },
  );

  it('still fixes a name that is not a common word', () => {
    expect(fix('ask skyloom and café', ['Skyloom', 'Café'])).toBe('ask Skyloom and Café');
  });

  it('does not guard phrases, hyphenated words, digits or internal capitals', () => {
    expect(fix('a red bull', ['Red Bull'])).toBe('a Red Bull');
    expect(fix('a sky-net', ['Sky-Net'])).toBe('a Sky-Net');
    expect(fix('a sky2', ['Sky2'])).toBe('a Sky2');
    expect(fix('a skyline and skyLine', ['SkyLine'])).toBe('a SkyLine and SkyLine');
  });

  it('applies the guard to a common word inside a larger dictionary', () => {
    expect(fix('will voxloom ship', ['Will', 'Voxloom'])).toBe('will Voxloom ship');
  });
});

describe('empty and degenerate dictionaries', () => {
  it('is the identity for an empty dictionary', () => {
    const text = 'Anything here, even  odd  spacing\u00e9';
    expect(fix(text, [])).toBe(text);
  });

  it('ignores blank, separator-only and duplicate entries', () => {
    const text = 'voxloom -- test';
    expect(fix(text, ['', '   ', '-', ' - ', 'Voxloom', 'voxloom'])).toBe('Voxloom -- test');
  });

  it('is the identity for empty text', () => {
    expect(fix('', ['Voxloom'])).toBe('');
  });
});

describe('idempotency', () => {
  const words = [
    'Voxloom', 'ChatGPT', 'GPT-3.5', 'New York', 'New York City', 'iPhone',
    'Node.js', 'Skyloom', 'Café', 'Will', 'Open AI',
    '--verbose', '-v', 'trailing-', 'Foo - bar', 'Bar', 'a--b', 'Θεσσαλονίκης Λιμάνι',
    'GitHub', 'src',
  ];
  const vocabulary = [
    'voxloom', 'chat', 'gpt', 'gpt-3.5', 'chat-gpt', 'new', 'york', 'city',
    'iphone', 'i', 'phone', 'node.js', 'skyloom', 'café', 'will', 'open', 'ai',
    'openai', 'the', 'and', 'sky', ',', '.', '-', 'voxloom\'s', 'GPT', '3.5',
    '--verbose', '--', '-v', 'trailing-', 'foo', 'bar', 'a', 'b', '/', 'src/gpt',
    'github.com', 'a.gpt', 'gpt.b', ':', '@', '=', '~', 'ΘΕΣΣΑΛΟΝΊΚΗΣ', 'λιμάνι', 'run',
  ];

  it('gives the same result when run twice over generated sentences (500 -> 3000 runs, edge-hyphen and code-like entries included)', () => {
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let run = 0; run < 3000; run += 1) {
      const length = 3 + Math.floor(next() * 14);
      const text = Array.from({ length }, () =>
        vocabulary[Math.floor(next() * vocabulary.length)]).join(' ');
      const once = fix(text, words);
      expect(fix(once, words), text).toBe(once);
    }
  });
});

describe('entries the matcher cannot read back as themselves', () => {
  it('skips an entry that starts or ends with a hyphen (run twice equals once)', () => {
    for (const entry of ['--verbose', '-v', 'verbose-', 'a-', '--']) {
      const text = 'run --verbose now, then -v, verbose- and a-';
      const once = fix(text, [entry]);
      expect(once, entry).toBe(text);
      expect(fix(once, [entry]), entry).toBe(once);
    }
  });

  it('does not grow the --verbose flag on a second pass', () => {
    const once = fix('run --verbose and verbose', ['--verbose', 'Verbose']);
    // The hyphen is a word edge, so the plain word still applies after it.
    expect(once).toBe('run --Verbose and Verbose');
    expect(fix(once, ['--verbose', 'Verbose'])).toBe(once);
    expect(fix('run --verbose', ['--verbose'])).toBe('run --verbose');
  });

  it('skips entries with spaced or doubled hyphens, which never match their own text', () => {
    const text = 'foo bar and a b';
    expect(fix(text, ['Foo - bar', 'a--b'])).toBe(text);
  });

  it('keeps entries with a single inner hyphen or spaces', () => {
    expect(fix('use gpt-4 and open ai', ['GPT-4', 'Open  AI'])).toBe('use GPT-4 and Open  AI');
    expect(fix('x open  ai', ['Open  AI'])).toBe('x Open  AI');
  });
});

describe('final sigma', () => {
  it('matches a Greek phrase whatever the case of its final letters', () => {
    const entry = 'Θεσσαλονίκης Λιμάνι';
    expect(fix('στο ΘΕΣΣΑΛΟΝΊΚΗΣ ΛΙΜΆΝΙ σήμερα', [entry])).toBe(`στο ${entry} σήμερα`);
    expect(fix('θεσσαλονίκης λιμάνι', [entry])).toBe(entry);
  });

  it('matches a single word that ends in a final sigma', () => {
    expect(fix('η ΑΚΡΌΠΟΛΙΣ είναι', ['Ακρόπολις'])).toBe('η Ακρόπολις είναι');
  });

  it('is stable on a second pass', () => {
    const once = fix('ΘΕΣΣΑΛΟΝΊΚΗΣ ΛΙΜΆΝΙ', ['Θεσσαλονίκης Λιμάνι']);
    expect(fix(once, ['Θεσσαλονίκης Λιμάνι'])).toBe(once);
  });
});

describe('code-like text', () => {
  const dictionary = ['Voxloom', 'GitHub', 'macOS', 'Tauri'];

  it.each([
    'src/voxloom/main', 'a\\voxloom', 'me@voxloom', 'my_voxloom', 'note:voxloom',
    '~voxloom', '$voxloom', '#voxloom', 'a=voxloom', '100%voxloom',
    'voxloom/main', 'voxloom\\x', 'voxloom@home', 'voxloom:run', 'voxloom=1',
    'com.voxloom.app', 'voxloom.app', 'github.com', 'voxloom.json', 'x.voxloom',
  ])('leaves %s alone', (text) => {
    expect(fix(text, dictionary)).toBe(text);
  });

  it('still fixes prose around punctuation and a plain sentence end', () => {
    expect(fix('voxloom. then voxloom, and voxloom! (voxloom) "voxloom"', dictionary))
      .toBe('Voxloom. then Voxloom, and Voxloom! (Voxloom) "Voxloom"');
    expect(fix('I like github.', dictionary)).toBe('I like GitHub.');
    expect(fix('.voxloom and ...voxloom', dictionary)).toBe('.Voxloom and ...Voxloom');
    expect(fix('really? voxloom...', dictionary)).toBe('really? Voxloom...');
  });

  it('fixes a word before a colon in prose, not before "::" or glued text', () => {
    expect(fix('tauri: a framework', dictionary)).toBe('Tauri: a framework');
    expect(fix('say tauri:', dictionary)).toBe('say Tauri:');
    expect(fix('tauri:\nnext line', dictionary)).toBe('Tauri:\nnext line');
    expect(fix('tauri::new and tauri:x', dictionary)).toBe('tauri::new and tauri:x');
    expect(fix('note:tauri', dictionary)).toBe('note:tauri');
  });

  it('does not treat a hyphen as code punctuation', () => {
    expect(fix('a github-hosted repo and macos-only', dictionary))
      .toBe('a GitHub-hosted repo and macOS-only');
    expect(fix('src-tauri', dictionary)).toBe('src-Tauri');
  });

  it('fixes a phrase entry in prose but not inside a path', () => {
    expect(fix('ask chat gpt now', ['ChatGPT'])).toBe('ask ChatGPT now');
    expect(fix('docs/chat gpt/x', ['ChatGPT'])).toBe('docs/chat gpt/x');
  });

  it('still fixes the other words in a line that has a skipped one', () => {
    expect(fix('src/voxloom and voxloom on macos', dictionary))
      .toBe('src/voxloom and Voxloom on macOS');
  });
});

describe('overlapping entries settle', () => {
  it('does not chain on the second pass (entries that overlap each other)', () => {
    const words = ['Chat GPT', 'AskChat'];
    const once = fix('ask chatgpt', words);
    expect(once).toBe('AskChat GPT');
    expect(fix(once, words)).toBe(once);
  });

  it('settles a longer chain and stays put', () => {
    const words = ['Four Seasons', 'GPT Four', 'AskGPT'];
    for (const text of ['ask gpt four seasons', 'askgpt four seasons now']) {
      const once = fix(text, words);
      expect(fix(once, words), text).toBe(once);
    }
  });

  it('still leaves one replacement alone when another entry only touches it', () => {
    expect(fix('in new york city', ['New York', 'York City'])).toBe('in New York city');
  });

  it('run twice equals once over generated text and random overlapping entry sets', () => {
    const pool = [
      'Chat GPT', 'AskChat', 'ChatGPT', 'Ask Chat', 'GPT Four', 'Four Seasons',
      'GPT-4', 'New York', 'York City', 'NewYork', 'Open AI', 'AI Studio',
      'OpenAI Studio', 'a b', 'b c', 'ab c', 'AskGPT', 'GPT', 'Studio X',
    ];
    // Heard forms of every entry (as said, run together, hyphenated) plus
    // filler, so entries often land next to each other.
    const heard = pool.flatMap((entry) => {
      const lower = entry.toLowerCase();
      return [lower, lower.replace(/[\s-]+/gu, ''), lower.replace(/\s+/gu, '-')];
    });
    const vocabulary = [...heard, ...heard, 'x', '-', ',', '.', 'the'];
    let seed = 99;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pick = <T,>(items: T[]) => items[Math.floor(next() * items.length)];
    for (let run = 0; run < 5000; run += 1) {
      const words = Array.from({ length: 2 + Math.floor(next() * 6) }, () => pick(pool));
      const text = Array.from({ length: 2 + Math.floor(next() * 9) }, () => pick(vocabulary)).join(' ');
      const once = fix(text, words);
      expect(fix(once, words), `${JSON.stringify(words)} ${text}`).toBe(once);
    }
  });
});

// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { replaceDictionaryTerms as fix } from '../../../src/services/dictionary/replace';

const APOSTROPHES = ['\'', '\u2019'];
const SHORT = ['Re', 'T', 'S', 'Ll', 'Ve', 'D', 'M', 'Brien', 'O', 'Voxloom', 'iPhone', 'Acme'];

describe.each(APOSTROPHES)('apostrophe %j inside a word', (q) => {
  it.each([
    [`we${q}re`, ['Re']],
    [`don${q}t`, ['T']],
    [`it${q}s`, ['S']],
    [`O${q}Brien`, ['Brien']],
    [`o${q}brien`, ['Obrien']],
    [`o${q}brien`, ['Brien', 'O']],
    [`l${q}iphone`, ['iPhone']],
    [`we${q}ll, you${q}ve, i${q}d, i${q}m`, SHORT],
  ])('no match starts right after it: %j with %j is unchanged', (text, words) => {
    expect(fix(text, words)).toBe(text);
  });

  it.each([
    [`voxloom${q}s menu`, ['Voxloom'], `Voxloom${q}s menu`],
    [`chat gpt${q}s answer`, ['ChatGPT'], `ChatGPT${q}s answer`],
    [`acme${q}s`, ['Acme'], `Acme${q}s`],
  ])('a match may end right before it: %j with %j', (text, words, expected) => {
    expect(fix(text, words)).toBe(expected);
  });

  // "Don" is not a guarded common word, but the end edge never stops before
  // a contraction tail other than 's; "Will" is guarded and dropped.
  it('leaves a name entry that is also a contraction head alone', () => {
    expect(fix(`i don${q}t know`, ['Don'])).toBe(`i don${q}t know`);
    expect(fix('ask don about it', ['Don'])).toBe('ask Don about it');
    expect(fix(`it will${q}ve been`, ['Will'])).toBe(`it will${q}ve been`);
  });

  it('is unchanged when run twice', () => {
    const text = `we${q}re sure it${q}s voxloom${q}s, don${q}t ask O${q}Brien`;
    const once = fix(text, SHORT);
    expect(once).toBe(`we${q}re sure it${q}s Voxloom${q}s, don${q}t ask O${q}Brien`);
    expect(fix(once, SHORT)).toBe(once);
  });

  it('still fixes entries next to a quote that is not inside a word', () => {
    expect(fix(`say ${q}voxloom${q} now`, ['Voxloom'])).toBe(`say ${q}Voxloom${q} now`);
    expect(fix(`we${q}re on voxloom`, SHORT)).toBe(`we${q}re on Voxloom`);
    expect(fix(`the users${q} voxloom`, ['Voxloom'])).toBe(`the users${q} Voxloom`);
  });
});

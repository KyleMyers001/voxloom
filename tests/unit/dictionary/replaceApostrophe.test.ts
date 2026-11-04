// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { replaceDictionaryTerms as fix } from '../../../src/services/dictionary/replace';

const APOSTROPHES = ['\'', '\u2019'];
const SHORT = ['Re', 'T', 'S', 'Ll', 'Ve', 'D', 'M', 'Brien', 'O', 'Voxloom', 'iPhone', 'Acme'];

describe.each(APOSTROPHES)('inside-word apostrophe %j counts as a word character', (q) => {
  it.each([
    [`we${q}re`, ['Re']],
    [`don${q}t`, ['T']],
    [`it${q}s`, ['S']],
    [`O${q}Brien`, ['Brien']],
    [`o${q}brien`, ['Brien', 'O']],
    [`o${q}brien`, ['Obrien']],
    [`voxloom${q}s`, ['Voxloom']],
    [`l${q}iphone`, ['iPhone']],
    [`acme${q}s`, ['Acme']],
    [`we${q}ll, you${q}ve, i${q}d, i${q}m`, SHORT],
  ])('leaves %j alone with %j', (text, words) => {
    expect(fix(text, words)).toBe(text);
  });

  it('is unchanged when run twice', () => {
    const text = `we${q}re sure it${q}s voxloom${q}s, don${q}t ask O${q}Brien`;
    const once = fix(text, SHORT);
    expect(once).toBe(text);
    expect(fix(once, SHORT)).toBe(once);
  });

  it('still fixes entries next to a quote that is not inside a word', () => {
    expect(fix(`say ${q}voxloom${q} now`, ['Voxloom'])).toBe(`say ${q}Voxloom${q} now`);
    expect(fix(`acme${q}s app voxloom`, ['Voxloom', 'Acme'])).toBe(`acme${q}s app Voxloom`);
    expect(fix(`we${q}re on voxloom`, SHORT)).toBe(`we${q}re on Voxloom`);
    expect(fix(`the users${q} voxloom`, ['Voxloom'])).toBe(`the users${q} Voxloom`);
  });
});

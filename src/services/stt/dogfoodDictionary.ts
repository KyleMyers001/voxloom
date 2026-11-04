/// Applies the user's dictionary spellings to a transcript (BUS-138).

import { replaceDictionaryTerms } from '../dictionary/replace';
import type { Transcript } from './types';

/**
 * The transcript with dictionary entries spelled as saved. The engine output
 * is kept as `rawText` (History), so only `text` carries the spellings.
 * Returns the same object when nothing changed.
 */
export function withDictionary(
  transcript: Transcript,
  words: readonly string[] | undefined,
): Transcript {
  if (!words?.length) return transcript;
  const text = replaceDictionaryTerms(transcript.text, words);
  if (text === transcript.text) return transcript;
  return { ...transcript, rawText: transcript.rawText ?? transcript.text, text };
}

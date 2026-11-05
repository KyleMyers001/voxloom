// @vitest-environment node
// BUS-188 (Sophie's ruling): with no dictionary words the cleanup prompt is
// byte-identical to main's (d2d4ee9, cleanup-v2), so people who do not use the
// dictionary get no new text, and the version row says so.
import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  CLEANUP_PROMPT_VERSION,
  CLEANUP_PROMPT_VERSION_NO_DICTIONARY,
  cleanupPromptVersion,
} from '../../../src/domain/cleanup';
import { buildCleanupPrompt } from '../../../src/services/cleanup/prompt';
import { createCleanupProvenance } from '../../../src/services/cleanup/provenance';
import { runCleanup } from '../../../src/services/cleanup/runCleanup';
import type { WritingStyle } from '../../../src/domain/types';
// Prompts that main d2d4ee9's buildCleanupPrompt produced for an empty
// dictionary, generated once from that commit (3 styles x 5 transcripts).
import mainPrompts from '../../fixtures/cleanup-prompt-main-d2d4ee9-empty-dictionary.json';

const PARAGRAPH = 'canonicalSpellings are words the speaker uses.';
const MAIN_LINE = 'Use canonicalSpellings only to correct the spelling of existing words.';

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto);
});

describe('an empty dictionary gives main\'s prompt', () => {
  it('has the fixture from main', () => {
    expect(mainPrompts).toHaveLength(15);
  });

  it.each(mainPrompts)('is byte-identical for $style: $rawText', (row) => {
    const prompt = buildCleanupPrompt({
      dictionary: [], rawText: row.rawText, style: row.style as WritingStyle,
    });
    expect(prompt).toBe(row.prompt);
    expect(prompt).toContain(MAIN_LINE);
    expect(prompt).not.toContain(PARAGRAPH);
  });

  it('sends the paragraph instead of main\'s line once there is a word', () => {
    const prompt = buildCleanupPrompt({
      dictionary: ['Voxloom'], rawText: 'hi', style: 'casual',
    });
    expect(prompt).toContain(PARAGRAPH);
    expect(prompt).toContain('Otherwise leave the words');
    expect(prompt).not.toContain(MAIN_LINE);
  });

  it('is the prompt the engine receives, also for a dictionary of blanks', async () => {
    const sent: string[] = [];
    const engine = {
      cancel: vi.fn(),
      run: vi.fn(async (request: { prompt: string }) => {
        sent.push(request.prompt);
        return 'Hi.';
      }),
    };
    const row = mainPrompts[0];
    for (const dictionary of [[], ['', '  ']]) {
      await runCleanup({
        engine, rawText: row.rawText, requestId: 'r1',
        signal: { aborted: false, onAbort: vi.fn() },
        snapshot: {
          dictionary, enabled: true, modelId: 'qwen3-0.6b-q4-k-m',
          style: row.style as WritingStyle,
        },
      });
    }
    expect(sent).toEqual([row.prompt, row.prompt]);
  });
});

describe('the version names the prompt that was built', () => {
  it('is main\'s for no words and v3 for some', () => {
    expect(CLEANUP_PROMPT_VERSION_NO_DICTIONARY).toBe('cleanup-v2');
    expect(CLEANUP_PROMPT_VERSION).toBe('cleanup-v3');
    expect(cleanupPromptVersion([])).toBe('cleanup-v2');
    expect(cleanupPromptVersion(['Voxloom'])).toBe('cleanup-v3');
  });

  it.each([
    [[], 'cleanup-v2'],
    [['', '  '], 'cleanup-v2'],
    [['Voxloom'], 'cleanup-v3'],
  ])('is recorded for dictionary %j as %s', async (dictionary, version) => {
    const provenance = await createCleanupProvenance({
      dictionary, enabled: true, modelId: 'qwen3-0.6b-q4-k-m', style: 'casual',
    }, { finalText: 'raw', reason: 'invalid-output', status: 'fallback' });
    expect(provenance.promptVersion).toBe(version);
  });
});

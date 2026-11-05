// @vitest-environment node
// BUS-138 PR B2: opt-in evaluation of the dictionary prompt and output check
// with the real cleanup model. It is skipped unless both variables are set:
//
//   VOXLOOM_TEST_CLEANUP_MODEL=/path/Qwen3-0.6B-Q4_K_M.gguf \
//   VOXLOOM_TEST_CLEANUP_WORKER=/path/voxloom-cleanup-worker \
//   VOXLOOM_EVAL_OUT=/tmp/eval.json npx vitest run tests/unit/cleanup/dictionaryEval.test.ts
//
// The worker is the release binary of src-tauri/worker. It runs each corpus
// sentence through the real prompt, the real worker and the real output check,
// then through the deterministic dictionary step, exactly as dictation does.
// Greedy decoding, CPU: indicative of the model's behaviour, not of Metal.
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import defaultCorpus from '../../fixtures/dictionary-eval/corpus.json';
import { buildCleanupPrompt, snapshotDictionary } from '../../../src/services/cleanup/prompt';
import { validateCleanupOutput } from '../../../src/services/cleanup/validation';
import { replaceDictionaryTerms } from '../../../src/services/dictionary/replace';

const MODEL = process.env.VOXLOOM_TEST_CLEANUP_MODEL;
const WORKER = process.env.VOXLOOM_TEST_CLEANUP_WORKER;
// VOXLOOM_EVAL_CORPUS: another corpus file of the same shape, for tuning.
const corpus: { dictionary: string[]; items: Item[] } = process.env.VOXLOOM_EVAL_CORPUS
  ? JSON.parse(readFileSync(process.env.VOXLOOM_EVAL_CORPUS, 'utf8'))
  : defaultCorpus;

interface Reply { ms: number; text: string | null }

/** One framed request on stdin and the model on fd 3, as the app does. */
function ask(prompt: string): Promise<Reply> {
  const model = openSync(MODEL!, 'r');
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(WORKER!, [], { stdio: ['pipe', 'pipe', 'ignore', model] });
    const { stdin, stdout } = child as typeof child & {
      stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream;
    };
    const chunks: Buffer[] = [];
    stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', () => {
      closeSync(model);
      const frame = Buffer.concat(chunks);
      if (frame.length < 4) return reject(new Error('worker sent no reply frame'));
      const reply = JSON.parse(frame.subarray(4).toString('utf8')) as
        { status: string; text?: string };
      resolve({ ms: Date.now() - started, text: reply.status === 'ok' ? reply.text ?? null : null });
    });
    const body = Buffer.from(JSON.stringify({
      modelPath: '/dev/fd/3', prompt, requestId: 'eval',
    }));
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    stdin.write(Buffer.concat([head, body]));
    stdout.once('end', () => stdin.end());
  });
}

type Outcome = 'fixed' | 'missed' | 'false-fix' | 'kept';

interface Row {
  fallback: boolean;
  final: string;
  id: string;
  model: string | null;
  ms: number;
  outcome: Outcome;
  proposed: boolean;
}

interface Item { expect?: string[]; id: string; kind: string; raw: string }

function mentions(text: string, word: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, 'u').test(text);
}

describe.skipIf(!MODEL || !WORKER)('dictionary cleanup, real model', () => {
  it('fixes mishearings from context and leaves look-alike words alone', async () => {
    const dictionary = snapshotDictionary(corpus.dictionary);
    const rows: Row[] = [];
    for (const item of corpus.items) {
      // Dictation hands cleanup the deterministically spelled transcript.
      const heard = replaceDictionaryTerms(item.raw, dictionary);
      const prompt = buildCleanupPrompt({ dictionary, rawText: heard, style: 'casual' });
      const reply = await ask(prompt);
      const checked = reply.text === null
        ? null : validateCleanupOutput(heard, reply.text, dictionary);
      const final = replaceDictionaryTerms(checked ?? heard, dictionary);
      const expected = item.expect ?? [];
      const added = dictionary.filter((word) => mentions(final, word)
        && !new RegExp(word, 'iu').test(item.raw));
      let outcome: Outcome;
      if (item.kind === 'fix') {
        outcome = expected.every((word) => mentions(final, word)) ? 'fixed' : 'missed';
      } else {
        outcome = added.length ? 'false-fix' : 'kept';
      }
      const proposed = reply.text !== null
        && dictionary.some((word) => mentions(reply.text!, word)
          && !new RegExp(word, 'iu').test(heard));
      rows.push({
        fallback: reply.text !== null && checked === null,
        final, id: item.id, model: reply.text, ms: reply.ms, outcome, proposed,
      });
    }
    const count = (test: (row: Row) => boolean) => rows.filter(test).length;
    const summary = {
      falseFixes: count((row) => row.outcome === 'false-fix'),
      fallbacks: count((row) => row.fallback),
      fixed: count((row) => row.outcome === 'fixed'),
      fixItems: count((row) => row.id.startsWith('fix')),
      keepItems: count((row) => row.id.startsWith('keep')),
      proposedFixes: count((row) => row.proposed),
      workerErrors: count((row) => row.model === null),
    };
    if (process.env.VOXLOOM_EVAL_OUT) {
      writeFileSync(process.env.VOXLOOM_EVAL_OUT, JSON.stringify({ rows, summary }, null, 1));
    }
    console.table(rows.map(({ final, id, outcome, fallback }) => ({ fallback, final, id, outcome })));
    console.log(JSON.stringify(summary));
    // The one hard property: a look-alike real word is never turned into a
    // dictionary word. Fix rates depend on the model and are only reported.
    expect(summary.falseFixes).toBe(0);
  }, 30 * 60_000);
});

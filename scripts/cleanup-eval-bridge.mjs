// Offline bridge only: load the shipped TS functions, never the UI/Tauri app.
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { createServer } from 'vite';

const MAX_BYTES = 8 * 1024 * 1024;
let server;
try {
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('bridge input limit');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!['prepare', 'validate'].includes(input.operation)
    || !Array.isArray(input.items) || input.items.length > 1000) {
    throw new Error('invalid bridge operation');
  }
  server = await createServer({
    configFile: false,
    envFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, watch: null, ws: false, hmr: false },
  });
  const prompt = await server.ssrLoadModule('/src/services/cleanup/prompt.ts');
  const guards = await server.ssrLoadModule('/src/services/cleanup/validation.ts');
  const identity = await server.ssrLoadModule('/src/services/cleanup/types.ts');
  const provenance = await server.ssrLoadModule('/src/services/cleanup/provenance.ts');
  const items = [];
  for (const item of input.items) {
    if (typeof item.rawText !== 'string' || !Array.isArray(item.dictionary)
      || !item.dictionary.every((word) => typeof word === 'string')) {
      throw new Error('invalid bridge item');
    }
    const dictionary = prompt.snapshotDictionary(item.dictionary);
    if (input.operation === 'validate') {
      if (typeof item.candidate !== 'string') throw new Error('missing candidate');
      items.push(guards.validateCleanupOutput(item.rawText, item.candidate, dictionary));
      continue;
    }
    if (!['casual', 'formal', 'very-casual'].includes(item.style)) {
      throw new Error('invalid style');
    }
    const result = {
      dictionary,
      dictionaryDigest: await prompt.digestDictionary(dictionary),
      prompt: null,
      reason: null,
    };
    // Match runCleanup's public preflight outcome. Unexpected bridge errors are
    // evaluation failures, never manufactured model/guard results.
    if (Buffer.byteLength(item.rawText, 'utf8') > prompt.CLEANUP_INPUT_MAX_BYTES) {
      result.reason = 'context-overflow';
    } else {
      result.prompt = prompt.buildCleanupPrompt({ ...item, dictionary });
    }
    items.push(result);
  }
  const output = JSON.stringify({
    items,
    modelId: identity.CLEANUP_MODEL_ID,
    modelDigest: identity.CLEANUP_MODEL_SHA256,
    promptVersion: provenance.CLEANUP_PROMPT_VERSION,
  });
  if (Buffer.byteLength(output, 'utf8') > MAX_BYTES) throw new Error('bridge output limit');
  process.stdout.write(output);
} catch {
  // Deliberately avoid reflecting prompts, inputs or Vite exception payloads.
  process.stderr.write('cleanup evaluation bridge failed\n');
  process.exitCode = 1;
} finally {
  if (server) await server.close();
}

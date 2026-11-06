// A faster scan must still extract every production source, even on cache hits.
import { readFileSync, readdirSync } from 'node:fs';
import console from 'node:console';
import process from 'node:process';

const sarif = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const extracted = new Set();
for (const run of sarif.runs ?? []) {
  for (const invocation of run.invocations ?? []) {
    for (const diagnostic of invocation.toolExecutionNotifications ?? []) {
      if (diagnostic.descriptor?.id !== 'swift/diagnostics/successfully-extracted-files') continue;
      for (const location of diagnostic.locations ?? []) {
        const uri = location.physicalLocation?.artifactLocation?.uri;
        if (uri) extracted.add(decodeURIComponent(uri));
      }
    }
  }
}

const sourceRoot = 'src-tauri/parakeet-worker/Sources';
const sources = readdirSync(sourceRoot, { recursive: true })
  .filter((file) => file.endsWith('.swift'))
  .map((file) => `${sourceRoot}/${file}`)
  .sort();
const missing = sources.filter((file) => !extracted.has(file));
if (sources.length === 0 || missing.length > 0) {
  console.error('CodeQL did not extract every production Swift source:');
  for (const file of missing) console.error(`  ${file}`);
  process.exitCode = 1;
} else {
  console.log(`CodeQL extracted all ${sources.length} production Swift files.`);
}

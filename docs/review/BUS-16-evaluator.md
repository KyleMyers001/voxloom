# BUS-16 cleanup evaluation kit

This is **cleanup-pipeline testing, not full-app E2E testing**. It exercises the
production prompt, a disposable worker, and production output guards. It does not
import models, change settings/history, capture speech, or perform OS delivery.
A completed run is not a quality pass, and raw fallback is not model success.

## Offline checks (no weights)

With the repository's existing npm dependencies installed and Node 24/Python 3.9+
(macOS; the POSIX runner also supports Linux):

```sh
npm run test:unit -- tests/unit/cleanup/corpus.test.ts
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/native -v
```

The version-1 fixture `tests/fixtures/cleanup-corpus.json` contains 23 synthetic,
non-sensitive cases, expanded to **138 variants**: `casual`, `formal`,
`very-casual`, each with dictionary off/on. Cases cover punctuation, fillers,
paragraphs, pronouns, negation, corrections, names, technical tokens, numbers,
quoted instructions, Unicode, repetition, dictionary spelling/joining and length
limits. Each ordinary case includes acceptable and dangerous contrast candidates.
The input-byte overflow case deliberately fails before a model attempt.

The native tool suite uses tiny synthetic files and fake executable workers. It
also calls the actual Node bridge. CI already discovers these tests in its macOS
job; neither CI job downloads or runs model weights.

## Actual-model run (opt-in)

Supply the existing allowlisted GGUF and explicitly chosen worker. This command
never downloads, installs, replaces, or enables anything. The output directory
must **not already exist**, its parent must exist, and it must be outside the
repository. Use synthetic corpus data only; the evidence intentionally contains
raw and generated text.

```sh
python3 scripts/evaluate-cleanup-worker.py \
  --worker /absolute/path/to/voxloom-cleanup-worker \
  --model /absolute/path/to/allowlisted-qwen3-0.6b-q4-k-m.gguf \
  --corpus tests/fixtures/cleanup-corpus.json \
  --output "$HOME/Workbench/Investigations/bus16-model-evaluation-UNIQUE"
```

Before quality evaluation, separately run `scripts/check-cleanup-template.py`
against the same approved GGUF/current checker to verify its actual metadata.
The evaluator does not replace that gate. There is no CLI allowlist bypass,
synthetic-model flag, deadline override, sampler change, or download option.

- Each eligible variant verifies a newly held no-follow model descriptor against
  `cleanup_model.PIN`, then inherits that same descriptor into a fresh worker.
- `cleanup-eval-bridge.mjs` loads the actual TS `prompt.ts`, `validation.ts`,
  `types.ts` and `provenance.ts` using installed Vite tooling. Dictionary snapshots,
  digests, prompt text, guard results and identity are not reimplemented in Python.
  It uses middleware mode with no HTTP/WebSocket listener, watcher, app config,
  `.env` loading, UI or Tauri connection, and closes Vite in `finally`.
- Worker input is the current three-field request and a big-endian length header;
  the serialized JSON body is capped at 128 KiB **before spawn**. Concurrent
  bounded pipe I/O preserves structured early errors even behind blocked stdin.
- Each worker has the existing **30-second** deadline, including process startup
  and I/O; descriptor verification and Node-bridge overhead are separate timings.
  Complete frames trigger process-group termination/reaping, like native
  settlement. Thus `exitCode` can be negative even for an accepted response; it
  is process evidence, not the cleanup outcome. The runner drains already-written
  output, rejects extra/malformed frames, and caps stderr at 8192 bytes without
  retaining its text. It does not monitor a worker indefinitely for later output.
- Worker error codes map like the native supervisor. Guard rejection is simply
  `invalid-output` / `production-guard-rejected`: the production guard returns
  text or null and does not supply a more specific rejection diagnosis.

Exit `0` means collection completed without supported-case worker/preflight
failures, **not** that cleanup was useful or safe. Exit `1` indicates harness
failure or supported-case worker/preflight failures; inspect the evidence.
Guard fallbacks and length-limit fallbacks can occur even with exit `0`.

## Evidence schema (version 1)

All new evidence lives inside the exclusively created, mode-0700 output directory:

- **`manifest.json`** — corpus version/hash, initial worker SHA-256, expected
  model identity, production prompt version, OS/architecture, deadline,
  `evidenceKind` and preparation-bridge duration. The worker hash fingerprints
  the supplied file before the run; it is not executable-descriptor attestation.
- **`attempts.jsonl`** — flushed after every attempt, before TS output validation.
  Each row has stable case/request IDs, categories, length class, style,
  dictionary mode and normalized snapshot/digest, raw text, candidate (or null),
  prompt/worker identity, actual `attempt` (or null), reason/detail, PID/exit code,
  verification and worker wall seconds, per-child peak RSS bytes, stderr byte
  count and the worker-reported truncation flag. These rows alone are **not**
  accepted-output evidence.
- **`cases.jsonl`** — adds `finalText`, outcome and pending human meaning review.
  Outcomes are `accepted-changed`, `accepted-unchanged`, `guard-fallback`,
  `worker-fallback`, and `preflight-fallback`. Every fallback preserves exact raw
  text. “Changed” includes trimming/formatting; it is not a usefulness judgment.
- **`summary.json`** — counts overall/by style and dictionary, timeout and
  worker-reported truncation counts, separate length-limit fallbacks and
  supported-case failures, first-process result, subsequent-process timings,
  supported/accepted timing distributions, verification timing and peak RSS.
  Distributions give count, median, nearest-rank p95 and maximum. Bridge timing
  is separate. `hasTenSubsequentSupportedProcesses` reports sample count only.
- **`failure.json`** — incomplete harness run, with no quality claim; existing
  attempt evidence is preserved. Bridge failures never become fabricated model
  results. A failed directory cannot be reused or silently overwritten.

RSS comes from `wait4` for **each individual child**, with macOS bytes/Linux KiB
normalized to bytes. It is not a subtraction of cumulative child high-water
marks, a total parent/Node/GPU memory measurement, or a RAM guarantee. Later runs
are fresh processes, **not** resident-model warm inference; OS caches are not
cleared. Worker wall duration is not isolated model-inference time.

Reported truncation means the pinned worker explicitly returned its fixed
`invalid-output` / `cleanup output was truncated` diagnostic. Other invalid
outputs are not guessed to be truncations. Length-limit cases remain separate
from supported short/medium requests in failure/performance summaries.

## Corpus format and review

The JSON object has integer `version: 1` and a `cases` array. Cases have unique
ASCII alphanumeric/hyphen `id`, `categories`, `rawText`, `dictionary`, and
contrast `candidates`. Optional `repeat` repeats the literal raw text for length
stress; `lengthClass: "length-limit"` keeps these cases out of supported-case
metrics. Optional `promptReason: "context-overflow"` is asserted by TS tests.
Candidates have `text`, optional literal `repeat`, and `acceptWhen` containing
`off` and/or `on` (empty means unsafe in both modes). Candidates are **never sent
to the model**. The evaluator only sends the raw transcript/dictionary/style.

Every run keeps `humanMeaningReview: "pending"` and `qualityPassed: false`.
Review raw/candidate/final side by side, especially protected values, negation,
roles, corrections and instruction-like text. Require zero unsafe accepted
changes plus genuinely useful cleanup in every style and best-effort dictionary
influence. Neither matching these fixtures nor accepting everything unchanged
establishes semantic equivalence. Record human findings separately; do not turn
a transport success into a quality certification.

A 2026-10-02 synthetic full-corpus run encountered one unexpected parent I/O
failure (child exit 0). It fell back safely and was reported as a supported-case
failure, not success. Root cause is unknown: 2400 instrumented attempts and three
later full-corpus runs did not reproduce it. Subsequent parent I/O failures now
carry `process-io-errno-N` in `detail` (numeric errno only, no exception text).
These later passes are not evidence that the intermittent issue was fixed.

Actual GGUF template verification and baseline/repaired corpus measurements are
now recorded in [real-model evaluation](BUS-16-model-evaluation.md). Prompt v2 and
additional symbol/quotation/capitalization checks address defects reproduced by
those runs; the corpus keeps their unsafe candidates as regressions. Human
quality review, packaged import, Tauri lifecycle, speech/delivery, history
integration, older-system compatibility and hosted CI remain separate gates
for PR #24.

# BUS-16 — real-model evaluation, 2026-10-02

**Useful but limited cleanup; not packaged-app acceptance or a general safety
certification.** The local allowlisted GGUF was read in place, never imported,
replaced or downloaded. All text came from the synthetic corpus.

## Identity and method

- Host: Apple M5, 24 GiB RAM, macOS 26.6.2 (25G83), arm64.
- Model: `qwen3-0.6b-q4-k-m`, 396705472 bytes, SHA-256
  `ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a`.
- Existing scratch worker from the approved optional macOS 13.3 build, SHA-256
  `646bfde57f1327d335168e4a7ae297976e2a4490b3d0f0572613fcc6b24c00dc`.
  Worker source, upstream pin, backends, greedy sampler and deadlines unchanged.
- The actual-GGUF metadata/non-thinking template check passed through the same
  renderer as generation. The scratch worker's strict signature check passed;
  no new app or worker resource was built/installed.
- [Evaluator](BUS-16-evaluator.md): 23 cases × three styles × dictionary off/on,
  138 variants, including 12 deliberate length-limit variants. Each eligible
  attempt fully verifies/holds the model descriptor and spawns a fresh worker.
  Node preparation/validation and descriptor verification are timed separately.

## Baseline, repair, and rerun

| Run | Changed accepted | Unchanged accepted | Guard fallback | Worker fallback | Preflight fallback |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original `cleanup-v1` | 0 | 0 | 126 | 6 | 6 |
| Plain-text `cleanup-v2`, old guards | 35 | 72 | 23 | 2 | 6 |
| `cleanup-v2`, strengthened guards | **17** | **72** | **41** | **2** | **6** |

All three full runs had **zero timeouts and zero supported-case worker/preflight
failures**. That does not make the first run successful cleanup: every supported
candidate was rejected, because the model returned the JSON envelope. Worker
fallbacks above are reported truncations on long-input stress cases. Final raw
fallback totals 49; 37 are supported-case guard rejections and 12 are length-limit
fallbacks. Nothing is counted as successful cleanup merely because raw survived.

The prompt now explicitly asks to copyedit the transcript value, return plain
text rather than JSON, and use canonical spellings only for existing words.
The final escaped JSON data line, all input limits and no-instruction-execution
rules remain. Prompt version advanced to `cleanup-v2`; historical v1 provenance
is not rewritten. Small experimental few-shot/footer probes were kept outside
production; they did not justify extra prompt machinery or sampler changes.

The first v2 run exposed **18 accepted defects**: six emoji deletions, six name
lowercasings, and six unwanted quotation wrappers. The final guards reject them:

- Preserve the sequence of symbols, emoji joiners/presentation selectors/tags.
- Preserve quotation-marker count and whether the whole response is quoted;
  ignore in-word apostrophes so supported contraction expansion still works.
- Do not introduce additional lowercase occurrences of a source-capitalized
  word; retain existing mixed-case repetitions and supported dictionary repairs.

These are conservative heuristics, not a full quote parser, named-entity system,
or semantic-equivalence proof. No guard was weakened and no wrapper was stripped
from a model response. Rejected candidates select exact raw fallback.

## Accepted changes and review boundary

All 17 final changed outputs were inspected by the coding agent:

- Six removed the internal hesitation `uh`, retaining the initial `um`.
- Eight added sentence-final punctuation (six across all styles; two casual).
- Three changed `Voxlom` to dictionary-specified `Voxloom`, once in each style,
  only with dictionary enabled.

All 72 unchanged outputs and 49 fallbacks exactly matched their raw input.
No unsafe accepted change was found in this fixed run's agent inspection. The
meaning-review artifact and evaluator summaries still say **human review pending**
and `qualityPassed: false`; coding-agent inspection is not Kyle's sign-off.

Usefulness remains modest. Most normal inputs are unchanged or fall back; the
model still mishandles some corrections, repetitions, quotation, casing and
technical formatting before guards. Dictionary joining did not improve in this
corpus. Style differentiation is weak. Useful punctuation/filler edits appear in
every style, but that is not proof of a polished Formal/Casual/Very Casual UX.

## Timing and memory (final guarded run)

| Measurement | Observed value |
| --- | ---: |
| First process of the final run | **11.726 s** worker + **0.146 s** verification |
| Supported requests, worker median / p95 | **0.256 s / 0.310 s** |
| Supported requests, worker maximum | **11.726 s** |
| Subsequent processes, all lengths, median / p95 / max | **0.256 s / 0.327 s / 7.439 s** |
| Descriptor verification median | **0.137 s** |
| Maximum worker RSS | **1,010,139,136 bytes (963.34 MiB)** |
| Worker deadline / observed timeouts | **30 s / 0** |

The first-ever actual-model request in this session took 0.611 s worker time;
that does **not** erase the later 11.726 s outlier. Its cause was not established.
All later samples also used fresh processes. OS caches were not cleared; none is
labelled resident-model warm inference. Worker duration includes startup, I/O and
teardown, not only inference. Per-child `wait4` RSS excludes parent/Node and is
not complete app/GPU memory or an older-device RAM/latency guarantee.

## Remaining evidence and open observation

The earlier one-off synthetic `process-io` fallback remains unexplained. Another
660 traced synthetic attempts and all three real-model corpus runs did not
reproduce it. Keep the errno diagnostic and observation open; these passes do not
establish a root-cause fix.

Fresh automated checks pass: 653 frontend tests/69 files, 33 Python/C++ tool tests,
lint/typecheck/build, six Chromium checks, both Cargo checks and five normal-
parallel default/Whisper suite pairs (177/176 each). Four existing Rust warnings
remain. Real GGUF runs are local opt-in evidence, not hosted/weight-free CI.

Still needed: human meaning/usefulness review, exact tested `.app` path and import
reproduction, permission-gated worker/app provisioning, Tauri lifecycle and native
speech/delivery/history validation, older OS/hardware validation, hosted CI and
final PR dispositions. Keep PR #24 draft. No push, merge, PR/Jira mutation or
interactive native test occurred in this stage.

Local logs, baseline/intermediate/final JSONL, source fingerprints and agent
review are retained under the Workbench investigation
`voxloom-bus16-model.1tQEmC`; the progress report links the detailed checkpoint.

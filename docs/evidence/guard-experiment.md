# BUS-16 cleanup guard experiment and QA verdicts (#122, #124)

Evidence for the cleanup content guard changes in #122 and #124, kept in the repo
so it doesn't live only in scratch files. Experiment only: nothing here changes
product behaviour.

- Fixtures: `tests/fixtures/guard-exp/` (`corpus.json` 50 items, `stress.json` 35
  candidates, `outputs.jsonl` 200 recorded worker replies).
- Test: `tests/unit/cleanup/guardExperiment.test.ts` replays them through the real
  `validateCleanupOutput` and pins the outcomes.
- The harness, scored tables and the variant guard wrappers (A1 to D) were not
  committed. They lived in scratch worktrees and are not product code.

## What was measured

Build D defaults: Qwen3-0.6B Q4_K_M (the app pin) and Qwen3-1.7B Q4_K_M, Formal
style, greedy decoding, the real `buildCleanupPrompt` and the real worker binary
built from the `build-d` branch at `2b61e3b` (a scratch build branch, not on main). It ran on Linux CPU (8 threads), not Metal, with no
`timeLeftMs` cap, so a Metal token difference is possible. The "loose" prompt
replaced the line "Use canonicalSpellings only to correct the spelling of
existing words." with permission to fix sound-alike mishearings.

Corpus: 50 items: 5 dictated, 12 mishearing, 14 dictionary, 5 negation, 5 number,
3 pronoun and 6 control. The 5 dictated items are 3 distinct sentences (jargon,
60-word and smirk), with the jargon and 60-word ones repeated as Casual variants.
The corpus is synthetic apart from those dictated sentences, and short, so measured acceptance probably overstates real long
dictation (the "Okay" effect).

## Baseline: the guard on Build D (variant A)

| Model | Accepted (50 items) | Rejections by first failing rule |
|---|---|---|
| 0.6B, app prompt | 33 (66%) | content 10, marks 5, capitalization 1, protected-values 1 |
| 1.7B, app prompt | 41 (82%) | content 6, capitalization 2, protected-values 1 |

The two rejections seen on Kyle's Mac build had two reproducible causes, not a too-strict guard:

1. **0.6B wraps the whole reply in quotes** (it copies the JSON string quotes from
   the prompt payload). 5 of 50 outputs on the app prompt (4 quote-wrapped, 1 JSON
   echo), never with 1.7B. `marks` and `whole-quote` rejected it.
2. **Models drop a standalone "Okay."** as a filler. The guard only allowed
   um/uh/erm/er/hmm, so it counted the loss as content. Both models dropped the
   final `Okay.` of the 60-word dictation.

A third cause, a real guard bug found while replaying the corpus: `protectedValues()` treated any lowercase-to-uppercase
word as a technical value that must appear in both texts, so an exact camelCase
dictionary spelling (StupidJargon, WhisperKit) was rejected before the join rule
ran. Every mixed-case dictionary term was impossible to apply.

#122 fixed all three, as the narrow variants A1 (dictionary spellings exempt from
protected values, one pair of whole-text quotes stripped) and A2 (a standalone
`Okay.`/`OK.` sentence may be dropped).

## Results by variant (real model outputs, 50 items each)

A and A2 are the shipped guard before and after #122. B, C and D are looser
variants that were tested and **not** shipped.

| Model, prompt | A | A2 | B/C (phonetic swaps) | D (dictionary repair only) |
|---|---|---|---|---|
| 0.6b app | 33 | 39 | 44 | 42 |
| 0.6b loose | 18 | 31 | 36 | 33 |
| 1.7b app | 41 | 43 | 44 | 43 |
| 1.7b loose | 43 | 44 | 45 | 44 |

All four A2 counts are asserted by the test against today's `main`. No variant
accepted a meaning change on the app prompt. B and C accepted one with the loose
prompt (0.6B: "mane conference room" to "man conference room").

Stress set (guard alone, 20 correct fixes, 15 meaning-changing corruptions):

| Variant | Correct fixes accepted | Corruptions accepted |
|---|---|---|
| A (Build D) | 0 | 0 |
| A1, A2 (shipped in #122) | 2 (both StupidJargon) | 0 |
| B (phonetic swaps) | 12 | **8** |
| C (B plus dictionary repair) | 16 | **8** |
| D (dictionary repair only) | 10 | **1** |

B and C accept accept to except, affect to effect, sell to sail, main to mane,
coast to cost, queen to Qwen and similar homophone corruptions, so general phonetic
swaps were not shipped. The negation, number and pronoun guards held in every
variant (don't to do, fifty to fifteen, he to she all blocked).

## Recommendation recorded at the time

1. Ship A1 and A2 as their own Medium-risk PR (done: #122).
2. Don't ship general phonetic swaps (B/C).
3. If more freedom is wanted, D: dictionary-scoped repair only, at most 2 repairs
   per text, 1 to 3 spoken words, metaphone codes equal or 1 apart at length 4 or
   more, exact dictionary casing. Not built.
4. Keep the app prompt. The loose prompt cut 0.6B acceptance from 66% to 36%
   because 23 of 50 outputs were quote-wrapped or JSON echoes.
5. Mishearings such as smirk to smoke need a stronger model or a different design.
   Neither Qwen3 size attempted that fix.

Dictionary repair gap that remains: Sofie to Sophie (2 edits), gira to Jira
(4 letters), tory to Tauri, queen to Qwen, fox loom to Voxloom, cooper netties to
Kubernetes. The current repair needs 5 or more letters and exactly one edit.

## QA verdict: #122 @ fc45dcb9c7322496ef0d3589d5ffdf120361050e

**PASS, Medium risk. No Mac pass required.** Base main `041e133`.

- vitest: base 130 files, 1652/1652; head 131 files, 1708/1708 (+56). Typecheck
  and lint exit 0 at both.
- 107 recorded edge-case probes against the real `validateCleanupOutput` at head and base:
  every result matched expectations. Regressions (25 negative probes plus 3 positive controls: negation, pronoun,
  number, capitalization, symbols, marks, coverage, protected values, reasoning
  markers, embedded quotes, dictionary over-repair) were identical at base and head.
- Replay of the saved raw outputs: `{ 0.6b: [50, 33, 39], 1.7b: [50, 41, 43] }`
  (total, base, head). Stress set 0/15 corruptions accepted. 8 outputs flip from
  rejected to accepted, all legitimate: 3 whole-text quote wraps with unchanged
  words, 1 Whisperkit to WhisperKit repair, 4 dropped final `Okay.`. The test
  asserts these 8.
- Mutation spot-check: 22 mutants, 19 killed, 3 survived (M5 unwrap `.trim()`,
  M9 dictionary `term.trim()` which was equivalent, M19 no space required after
  `Okay.`).
- CI: 12/12 check-runs succeeded at the head SHA. The stale `in_progress`
  browser-app record had a `success` conclusion.
- Lows: M19 test gap, M5 test gap, `Okay…` (U+2026) stayed required, `"text".`
  not unwrapped. The last two were fixed in #124.

## QA verdict: #124 @ 77a046728a4f300c4d57610c0ef1c32a28c9aeed

**PASS, Low risk. No Mac items.** Base main `7ac5654` (#117 on top of #122).
4 files, +99/-10.

- vitest: base 132 files, 1717/1717; head 133 files, 1742/1742 (+25). Typecheck
  and lint exit 0 at both.
- 30 `Okay…` probes and 47 `"text".` unwrap probes, plus 2 dictionary-trim probes.
  Each `"…".` wrapped change (dropped "not", changed number, added sentence, changed
  word, pronoun swap, lost embedded quote, symbol loss, reasoning marker, marks
  loss) was rejected at base and head.
- #122 probe set re-run: **104/107 identical**. The 3 differences are intended:
  `Okay…` rejected to accepted (#122 Low-3), `"…".` with the period outside the
  quote rejected to accepted (#122 Low-4), and a padded dictionary term
  `"  WhisperKit "` passed directly accepted to rejected (from removing
  `term.trim()`; production callers use `snapshotDictionary`, which trims, so it
  fails safe). The test asserts all three.
- Replay: `{ 0.6b: [50, 33, 39, 39], 1.7b: [50, 41, 43, 43] }` (total, pre-#122,
  base, head). No flips between base and head. Stress set 0/15 corruptions
  accepted, 2/20 good at both.
- Mutation spot-check: 22 mutants, 16 killed, 6 survived (N5 `…` after the closing
  quote, N6 space before the period, N8/N9 `…`/`!` not counted as an inner
  sentence end, N16 space before `…`, N22 equivalent).
- CI: 12/12 check-runs succeeded at the head SHA.
- Lows: N5/N6 test gap, N8/N9 test gap, `"Send the report,".` pastes
  `Send the report,.` (cosmetic), N16 test gap. Observation: `…` in
  `opensSentence` also lets a title-case filler or article after `…` drop, as base
  already allows after `...`.

## Caveats

- CPU, not Metal. A Metal re-run of the exact jargon and 60-word candidates
  is a nice-to-have and gates nothing.
- The fixture holds 3 test dictations (already in `falseRejections.test.ts`)
  and synthetic items. There are no keys, addresses or personal data.
- `outputs.jsonl` records outputs from the models, not a claim about model quality
  on real dictation.

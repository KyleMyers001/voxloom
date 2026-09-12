# BUS-9 native capture review checkpoint

Branch: `bus-9-native-capture`.

This checkpoint documents approved Slice A and proposed Slice B. It does not
claim BUS-9 is complete.
No microphone was opened and no TCC state was read or changed during this
slice.

## Slice A: event access and request ownership

### Tauri capability

`src-tauri/capabilities/main.json` grants only these core permissions to the
window labelled `main`:

- `core:event:allow-listen`
- `core:event:allow-unlisten`

`tauri.conf.json` selects that capability by identifier. The capability was
validated by a non-launching debug host build. Its generated effective form
was inspected at `src-tauri/target/debug/build/voxloom-*/out/capabilities.json`
and contained the `main` window plus exactly those two event permissions.
No emit permission or unrelated core/plugin permission was added.

### Correlated request lifecycle

The renderer creates a unique client request ID synchronously before its
first await. Listener registration must resolve successfully before the hook
can invoke `capture_start`. The same request ID is sent to start and cancel.

Native session reservation stores these values atomically before spawning the
worker:

- client request ID;
- native generation;
- capture mode;
- cancellation flag.

Every session event carries both request ID and generation. Permission query
events use their command request ID and generation zero because they are not
capture sessions. The status command returns the exact active request ID,
generation, and mode, or `null` while idle; it no longer returns a boolean or
creates a renderer-side fake generation.

Cancellation accepts a client request ID. If cancellation arrives before the
start command reserves a worker, native code retains a bounded, exact-ID
tombstone. A later start with that same ID terminates as cancelled before
opening the stream. Other current or future request IDs are unaffected.

Renderer cleanup cancels only the request owned by that hook instance. It
does not call a process-wide cancel command. A terminal event received before
the start response clears ownership, and the later response cannot restore
the running state. Events from another request or from a mismatched known
generation are ignored.

### Browser behavior

Runtime detection uses `isTauri()` from `@tauri-apps/api/core`; it does not
depend on `window.__TAURI__` or `app.withGlobalTauri`. Browser service methods
do not invoke native IPC. Settings displays an explicit native-unavailable
message and disables the microphone selector and action button.

### Generated lint output

The ESLint global ignore list now includes:

- `playwright-report-release`
- `test-results-release`

The same paths were already present in `.gitignore`. Source files remain in
lint scope.

## Slice B: normalized duration and production auto-stop

`Downmixer` now tracks total accepted native frames, native frames processed
through Rubato, startup delay still to discard, and canonical frames emitted.
It removes Rubato's reported startup delay once and emits exactly:

```text
round(input_frames * 16_000 / native_rate)
```

The implementation uses integer nearest rounding so duration conversion is
deterministic and does not accumulate floating-point error across chunks.
Full and fragmented calls therefore produce identical samples and exact frame
counts. Flush runs for completed captures even at exact input-block boundaries.
It zero-pads a partial block when needed and feeds a bounded number of silent
Rubato blocks until the aligned canonical tail is complete. A repeated flush
is idempotent.

The existing windowed-sinc parameters and anti-aliasing tests are unchanged.
No resampling work moved into the real-time callback; it remains on the
capture worker. PCM remains bounded, in-memory mono `f32`, and never crosses
IPC or logging boundaries.

The capture loop now receives a monotonic runtime and duration limits. The
production limits remain ten seconds for microphone tests and 120 seconds for
full capture. Coordinator tests run those production limits through the same
deadline branch with a virtual monotonic runtime. At the deadline, the loop
atomically closes the real-time callback's acceptance gate, drains the
now-finite bounded ring, waits for a callback that already passed the gate to
finish, flushes the resampler exactly once, and emits one terminal event after
scoped stream teardown and reservation release.

The acceptance flag and callback lease count form one `SeqCst` protocol. A
callback increments its lease before reading the flag; the closer stores
`false` before reading the lease count. In the resulting single global order,
a callback that read `true` either remains visible to the closer or has already
completed its write and released its lease. A model test enumerates all ten
legal interleavings of callback acquire/check/release and closer close/check.
This is an explicit model of the protocol rather than a scheduler stress test;
production-path tests separately cover closed callbacks and waiting for an
accepted callback. These callback operations remain allocation-, lock-, log-,
and IPC-free. The old fake clean-stop signal has been removed.

## Direct test coverage added or changed

- Service tests verify real-runtime detection, browser fail-closed behavior,
  correlated start/cancel arguments, active status, listener payloads, and
  synchronous unique request IDs.
- Hook tests use deferred listener and start promises to verify listener-ready
  gating, duplicate-start suppression, terminal-before-response behavior,
  cancellation before a response, unmount-before-subscribe cleanup, listener
  rejection, busy normalization, fresh remount gates, and adoption/cancellation
  of exact native status ownership.
- Native coordinator tests verify atomic status reservation, exact request-ID
  cancellation before start, isolation of the next request, active status,
  and request ID plus generation on emitted session events.
- Resampler tests cover exact frame counts at 44.1 and 48 kHz for tiny,
  partial, exact-block, and multiblock inputs; 16 kHz passthrough; fragmented
  versus single-call equality; exact-block tail drain; and a trailing impulse
  at the delay-compensated canonical index. Existing passband, stopband, and
  silence assertions remain active.
- Coordinator timing tests run `CaptureLimits::production()` through actual
  coordinator sessions. Test mode emits one correlated `TestComplete` at ten
  simulated seconds. Full mode is still active with no terminal at ten seconds
  and emits one correlated `CaptureStopped` at 120 seconds. Both verify stream
  teardown and reservation cleanup. Short-limit tests separately verify exact
  44.1 kHz metadata, one flush, queue draining, and bounded-buffer errors.
- Stream adapter tests verify that a closed deadline gate discards subsequent
  callback frames without overflowing the ring. A capture-loop test verifies
  that an already accepted callback finishes before queue draining begins.
- Browser component and Playwright coverage verify unavailable copy and
  disabled microphone controls.

## Verification for this checkpoint

```text
cargo test
  66 passed; 0 failed; no warnings

npm run typecheck
  passed

npm run lint
  passed, including generated-output ignores

npm run test:unit
  81 passed in 25 files

npm run build
  passed

npm run test:e2e:release
  1 passed

cargo check
  passed; no warnings

cargo fmt -- --check
  reports the repository's existing rustfmt differences, beginning in
  unchanged buffer.rs and consumer.rs; no broad formatting rewrite applied
```

Slice A also verified:

```text
npm run test:e2e -- --grep 'screens, settings'
  1 passed

npm run tauri -- build --debug --no-bundle --ci
  passed; host binary built without launch
```

The earlier unsigned app bundle and effective
`NSMicrophoneUsageDescription` inspection were performed by the main agent;
they were not repeated in Slice B.

## Audited file sizes after Slice B

```text
src-tauri/src/capture/coordinator.rs        2182 lines
src-tauri/src/capture/resample.rs            445 lines
src-tauri/src/capture/stream.rs               504 lines
src-tauri/src/lib.rs                         152 lines
src/services/capture/captureService.ts        65 lines
src/services/capture/types.ts                 87 lines
src/services/capture/useCaptureState.ts       311 lines
tests/unit/useCaptureState.test.ts            274 lines
```

## Explicitly remaining after Slice B

The following reviewed work is deferred to separately gated slices:

1. Stable native device identity, selection refresh, hot-plug, and switching.
2. Foreground microphone and natural permission-state checks by the user.

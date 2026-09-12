# BUS-9 native capture review checkpoint

Branch: `bus-9-native-capture`.

This checkpoint documents approved Slices A and B plus corrected Slice C. It
does not claim BUS-9 is complete.
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

The mount-time native status query has a separate ownerless-terminal race:
native may sample an active status, emit its terminal event, and only then
resolve the status promise. While that one status query is pending, the hook
retains at most 32 terminal request/generation pairs. An exact matching status
is rejected rather than adopted. Unrelated pairs do not block a valid owner.
The cache is cleared when the status query settles. If more than 32 terminals
arrive during that single query, status adoption fails closed and capture
controls remain unavailable rather than risking stale ownership.

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

## Slice C: device identity, refresh, and safe switching

The renderer and native command boundary now use device descriptors with an
opaque `id`, display-only `label`, and current `available` state. The special
system-default choice has a shared renderer constant and is resolved from the
current CPAL host on every start. Explicit choices are never matched by label
or list index and never fall back to the default device.

CPAL is pinned to maintained release 0.17.3. On macOS its public
`DeviceTrait::id()` reads `kAudioDevicePropertyDeviceUID` and returns a
`DeviceId(HostId::CoreAudio, uid)`. `HostTrait::device_by_id()` re-enumerates
and compares those IDs. The native UID is retained only inside the process;
the renderer receives a monotonically assigned opaque ID. Labels, enumeration
order, and numeric `AudioDeviceID` values never participate in identity.

The 0.17.3 migration raises CPAL's documented minimum Rust version to 1.78
(the verified project toolchain is 1.97) and updates `coreaudio-rs` to 0.14.2.
Direct target-macOS dependencies `objc2-core-audio` 0.3.2,
`objc2-core-foundation` 0.3.2, and `dispatch2` 0.3.1 expose the maintained
listener and UID-translation bindings used by the monitor. No crate is
vendored and no frontend dependency changed. CPAL's changed sample-rate and
device-description APIs were migrated; newly exposed CoreAudio I8/I24 formats
fail explicitly rather than entering an untested conversion path.

The registry reconciles by persistent UID. A UID label change preserves its
opaque ID, and a reconnect with the same UID restores that ID while a different
UID receives a new ID even if its label is identical. Missing, unreadable,
empty, or duplicate UIDs fail closed. Exact-device resolution performs a fresh
UID enumeration and verifies both the resulting UID and input capability.
At most 32 unavailable descriptor tombstones are retained. Eviction drops UID
metadata but never reuses an opaque ID.

Native enumeration and reconciliation execute under one registry mutex. A
slow older snapshot therefore cannot apply after a newer list or resolve.
An enumeration error leaves the prior registry snapshot unchanged. Settings
keeps a selected missing opaque ID and label as an unavailable option even if
its native tombstone has been evicted. No UID or CPAL handle is persisted,
logged, or sent with audio.

### macOS identity monitor

Capture acceptance starts closed. Before the first identity validation, the
adapter registers a system `kAudioHardwarePropertyDevices` listener, translates
the expected UID to the current `AudioDeviceID`, then registers selected-device
`DeviceIsAlive` and `DeviceUID` listeners. All listeners use one private serial
dispatch queue. Their callback performs only a `SeqCst` atomic invalidation;
it does not query CoreAudio, allocate, lock, block, log, or emit IPC.

The adapter validates the CPAL device UID, UID-to-`AudioDeviceID` translation,
and alive state before stream construction and after play. It synchronizes the
listener queue before the post-play validation. One atomic gate contains both
OPEN and INVALIDATED state: opening is a compare-and-exchange from CLOSED,
while invalidation stores sticky INVALIDATED. Therefore an invalidation that
wins first cannot be reopened; one that wins later closes acceptance.

On completion the adapter closes acceptance, waits for all accepted callback
leases, drops the stream, synchronizes queued listener callbacks, validates
again, removes listeners in reverse order, and synchronizes before releasing
their blocks. Any identity mismatch, topology/alive notification, listener
setup/cleanup failure, or final invalidation returns `capture-unavailable` and
discards the entire in-memory PCM result. Overflow remains a distinct error.
Resources and listeners are cleaned before coordinator reservation release and
the single correlated terminal event.

This is not an atomic hardware transaction. It rejects UID mismatch and
topology uncertainty visible through CoreAudio queries or delivered listener
callbacks, but cannot claim to detect an OS notification that CoreAudio has not
yet delivered or enqueued. Queue synchronization drains already-enqueued work;
it is not represented as proof that every pending hardware notification has
arrived. Real unplug/reconnect timing remains a foreground verification gap.

Device listing is a command response rather than an uncorrelated event. It
enumerates input metadata without querying/requesting microphone permission
or opening a stream. List errors preserve the renderer's last successful
catalog. Sequence numbers prevent an older refresh response from replacing a
newer one. Settings includes an explicit refresh action and retains a selected
missing ID as an unavailable option instead of silently changing selection.

Before committing a selection change, the capture hook cancels its exact
owned request and waits for the matching terminal event. The terminal is
emitted only after stream teardown and reservation release under Slice A.
Unrelated or stale terminal events cannot unlock the change. Concurrent
switch attempts share one cancellation; only the newest attempt may commit.
A five-second missing-terminal timeout fails closed, leaves the selection
unchanged, and starts no replacement capture. Unmount resolves pending switch
waiters as unsuccessful and does not cancel another request. Settings also
stays locked until the native active-status query has established ownership.
Switching never automatically restarts capture.

The existing stream-error path remains the during-capture disappearance seam:
CoreAudio callback errors produce `capture-unavailable`, close acceptance,
drain the bounded queue safely, and emit one terminal event after teardown.
The real-time callback remains allocation-, lock-, log-, blocking-, and
IPC-free; Slice B's `SeqCst` gate and lease protocol is unchanged.

## Direct test coverage added or changed

- Service tests verify real-runtime detection, browser fail-closed behavior,
  correlated start/cancel arguments, active status, listener payloads, and
  synchronous unique request IDs.
- Hook tests use deferred listener and start promises to verify listener-ready
  gating, duplicate-start suppression, terminal-before-response behavior,
  cancellation before a response, unmount-before-subscribe cleanup, listener
  rejection, busy normalization, fresh remount gates, and adoption/cancellation
  of exact native status ownership.
- Slice C hook tests use deferred status, refresh, cancellation, and terminal
  events to verify ownership-ready locking, terminal-before-status rejection,
  unrelated-terminal isolation, bounded-cache fail-closed behavior,
  newest-refresh wins, list-error retention, exact terminal matching, rapid
  switch coalescing, timeout failure, and unmount cleanup.
- Settings tests verify teardown precedes selection commit, failed teardown
  preserves the old selection, a missing selected ID remains visibly
  unavailable, testing is disabled for that selection, and browser controls
  remain truthfully unavailable.
- Native coordinator tests verify atomic status reservation, exact request-ID
  cancellation before start, isolation of the next request, active status,
  and request ID plus generation on emitted session events.
- Native device tests verify duplicate labels receive distinct IDs, label
  changes and same-UID reconnects preserve identity, direct UID replacement
  without an empty snapshot never rebinds the old ID, tombstones remain bounded,
  IDs are never reused, and stale/unknown IDs fail without fallback. Duplicate
  or unreadable UID snapshots preserve prior state. Resolution rejects UID
  mismatch and output-only devices. A deliberately delayed older enumeration
  proves list/resolve reconciliation is serialized.
- Identity tests verify sticky atomic invalidation before opening and during
  every stream phase, reverse listener cleanup, partial-registration cleanup,
  continued cleanup after a removal error, and listener-block lifetime through
  the dispatch-queue barrier. A coordinator integration test verifies a final
  identity failure discards PCM and emits one correlated error after resource
  teardown. A direct capture-loop test verifies invalidation remains distinct
  from overflow.
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
  92 passed; 0 failed; no warnings

npm run typecheck
  passed

npm run lint
  passed, including generated-output ignores

npm run test:unit
  95 passed in 25 files

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
they were not repeated in Slices B or C.

## Audited file sizes after Slice C

```text
src-tauri/src/capture/coordinator.rs        2746 lines
src-tauri/src/capture/resample.rs            445 lines
src-tauri/src/capture/stream.rs              1066 lines
src-tauri/src/capture/identity.rs             394 lines
src-tauri/src/capture/identity/macos.rs       174 lines
src-tauri/src/capture/identity/macos_api.rs   113 lines
src-tauri/src/lib.rs                         149 lines
src/services/capture/captureService.ts        66 lines
src/services/capture/types.ts                 96 lines
src/services/capture/useCaptureState.ts       485 lines
src/features/settings/Settings.tsx            398 lines
tests/unit/useCaptureState.test.ts            534 lines
tests/unit/Settings.test.tsx                  174 lines
```

The new identity runtime surfaces remain below 200 logical lines: common gate
and listener ownership ends before the test module at line 181, the macOS
monitor is 174 physical lines, and low-level CoreAudio queries end before the
test module at line 95. Existing stream/coordinator files remain oversized,
with most additional lines in direct tests. This narrow correction retained
their established backend and lifecycle seams rather than mixing a broad file
split into the native-identity change. Further decomposition remains warranted.

## Explicitly remaining after Slice C

The following work requires user-driven foreground verification or a future
scope decision:

1. Real CoreAudio enumeration, duplicate-label selection, default-device
   changes, unplug/reconnect, and stream-error timing.
2. Natural microphone permission-state checks by the user.
3. Notification-delivery timing that is not exposed by CoreAudio queries or an
   already-enqueued listener callback; no atomic hardware transaction is
   claimed.

Foreground checklist, not performed by Forge:

- Refresh with two same-label microphones and confirm each remains selectable
  independently.
- Change the system default between two tests and confirm the new default is
  used without changing the saved sentinel.
- Select an explicit USB microphone, unplug it before testing, and confirm the
  selection stays visible as unavailable with no default fallback.
- Unplug during a test and confirm one `capture-unavailable` terminal appears
  only after the system microphone indicator clears.
- Reconnect and refresh. The same persistent UID should restore the same opaque
  selection; replacement hardware must appear under a different opaque ID.
- Exercise permission states only through normal foreground prompts and System
  Settings; do not reset or manipulate TCC data.

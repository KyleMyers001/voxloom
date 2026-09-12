# BUS-9 native capture review checkpoint

Branch: `bus-9-native-capture`.

This checkpoint documents Slice A only. It does not claim BUS-9 is complete.
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
- Browser component and Playwright coverage verify unavailable copy and
  disabled microphone controls.

## Verification for this checkpoint

```text
cargo test
  58 passed; 0 failed; no warnings

npm run typecheck
  passed

npm run lint
  passed, including generated-output ignores

npm run test:unit
  81 passed in 25 files

npm run test:e2e -- --grep 'screens, settings'
  1 passed

npm run tauri -- build --debug --no-bundle --ci
  passed; host binary built without launch
```

The earlier unsigned app bundle and effective
`NSMicrophoneUsageDescription` inspection were performed by the main agent;
they were not repeated in Slice A.

## Audited file sizes after Slice A

```text
src-tauri/src/capture/coordinator.rs        1603 lines
src-tauri/src/lib.rs                         152 lines
src/services/capture/captureService.ts        65 lines
src/services/capture/types.ts                 87 lines
src/services/capture/useCaptureState.ts       311 lines
tests/unit/useCaptureState.test.ts            274 lines
```

## Explicitly remaining after Slice A

The following reviewed work is deferred to separately gated slices:

1. Correct FIR delay removal and exact canonical resampler duration/tail.
2. Stable native device identity, selection refresh, hot-plug, and switching.
3. Production-clock coverage of the real ten-second auto-stop path and
   removal of the fake clean-stop success seam.
4. Foreground microphone and natural permission-state checks by the user.

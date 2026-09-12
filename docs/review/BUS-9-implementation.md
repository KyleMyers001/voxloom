# BUS-9 — Native capture implementation review

Branch: `bus-9-native-capture`. Base: `32f3d01` (bus-4-mock-ui HEAD).

## Dependency rationale

| Crate | Version pinned | Reason |
|---|---|---|
| `cpal` | 0.15.3 | Only stable cpal with CoreAudio input support on macOS; 0.18 was available but APIs and feature flags differ — 0.15 was verified by cargo search then fetched and inspected. |
| `rubato` | 0.14.1 | FastFixedIn::new signature confirmed from source before use; 0.14 API matches usage. rubato 5.0 was available but 0.14 has the verified stable polynomial resampler API. |
| `objc2` | 0.6 | Required ≥ 0.6.2 by both objc2-av-foundation 0.3.2 and block2 0.6. Using 0.5 caused `IntoBlock` trait bound failures (two crates from the same workspace must share the objc2 version). |
| `objc2-av-foundation` | 0.3.2 | Provides `AVCaptureDevice::authorizationStatusForMediaType:` and `requestAccessForMediaType:completionHandler:`. Needed AVCaptureDevice + AVMediaFormat features only. |
| `objc2-foundation` | 0.3.2 | Transitive; pulled by av-foundation. |
| `block2` | 0.6 | Same version as the one objc2-av-foundation uses; required for `DynBlock<dyn Fn(Bool)>` compatibility. |
| `serde` | 1 with derive | Required for `#[derive(Serialize)]` on `SessionEvent` and `TestCaptureMetadata` for Tauri IPC. |

Frontend packages: no new npm dependencies. `@tauri-apps/api` (already present at 2.11.0) provides `invoke` and `listen`.

## Implementation surface audit

### Rust modules (src-tauri/src/capture/)

| Module | Lines | Direct tests | Notes |
|---|---|---|---|
| `buffer.rs` | ~135 | 6 unit tests (push/overflow/partial/duration/empty/into_samples) | Core safety invariant; overflow path is the 120-s bound guard |
| `resample.rs` | ~165 | 5 unit tests (mono passthrough, stereo downmix, 44100→16000, flush variants) | Within 200-line limit; size justified by the downmix + resampler + staging state cohesion |
| `permission.rs` | ~120 | 2 unit tests (variants distinct, copy semantics) | macOS-only real impl + non-macOS stub |
| `stream.rs` | ~155 | 2 unit tests (debug repr, error round-trip) | Real device tests require live CoreAudio |
| `consumer.rs` | ~95 | 6 unit tests (silence, noise, threshold, frame count, duration, empty) | One-shot: takes buffer, returns metadata, disposes audio |
| `coordinator.rs` | ~340 | 8 unit tests + 3 integration tests (busy reject, stop idempotent, permission conversion, active flag, synthetic accumulate, overflow path, stop flag) | Largest module; justified by lifecycle/race/watchdog cohesion |
| `lib.rs` | ~130 | Covered by integration tests | IPC command wiring only |
| `mod.rs` | 8 | N/A (re-exports only) | Trivial |

**Size exceptions**: `coordinator.rs` at ~340 lines exceeds 200. Rationale: the coordinator owns the single-session invariant, permission gating, stream lifecycle, watchdog, and buffer transfer. Splitting these would require shared mutable state across module boundaries, creating more complexity than it resolves. The module's 3 inline integration tests directly validate the split-able paths (accumulate, overflow, stop-flag). Acceptable for this slice; BUS-10 will likely split out the STT pipeline step.

**Coverage exceptions**: `stream::open_input` and `permission::query/request` are not unit-tested because they require a live CoreAudio session and TCC database. These are listed as manual pending tests below.

### Frontend modules (src/services/capture/)

| Module | Lines | Direct tests | Notes |
|---|---|---|---|
| `types.ts` | ~65 | N/A | Types only; no runtime behavior |
| `captureService.ts` | ~55 | 9 unit tests (all IPC calls + event channel) | Thin IPC wrapper |
| `useCaptureState.ts` | ~100 | 11 unit tests | Hook covering all event kinds, stale-event guard, runMicTest, stopMicTest |

### UI components updated

| Component | Change | Test coverage |
|---|---|---|
| `Onboarding.tsx` | Step 1 replaced: real permission status, Enable Microphone / Test Microphone buttons | 10 Onboarding tests; mock provides controlled permission |
| `Settings.tsx` | Mic section: real device list, real mic test, honest retention copy | 7 Settings tests |
| `App.tsx` | Sidebar note updated to remove false "no audio capture" claim | App integration tests |

**Components left mock**: shortcut/model/StartAtLogin all retain `· simulated` labels per brief.

## Verification commands run

```sh
# Rust
cargo check        # clean (0 errors, 0 warnings after fixes)
cargo test         # 29/29 passed

# Frontend
npm run typecheck  # clean
npm run lint       # clean
npm run test:unit  # 83/83 passed
npm run build      # clean (254.87 kB / 78.35 kB gzip)
```

All commands run in `/Users/kylemyers/dev/forge/voxloom`.
Rust toolchain: cargo 1.97.0 (Homebrew), rustc 1.97.0.
Node: v24.19.0. Vite 8.3.0. TypeScript 5.9.3.

## Safety and privacy invariants

- No PCM bytes cross the IPC boundary. `TestCaptureMetadata` contains only
  `frame_count`, `duration_secs`, `peak_level`, and `detected_activity`.
- No audio is persisted to disk at any point in the capture path.
- `stopCapture()` is called on window `CloseRequested` and on React unmount.
- The 120-second safety bound is enforced by the `CaptureBuffer::push` limit
  and the coordinator's `FULL_SAFETY_SECS` loop guard.
- The 10-second test bound is `TEST_SAFETY_SECS`; the coordinator does not
  wait for the user to call stop.
- `TCC_DB` is never touched; `AVCaptureDevice::requestAccessForMediaType:`
  is the only permission-related system call.
- Callback queue is bounded at `QUEUE_CAPACITY = 512`; overflow silently
  drops samples; the watchdog detects extended silence.
- Only one session may be active; a second `start_session` returns `"busy"`.

## Manual tests pending (not performed by Forge)

Kyle will run these in a foreground session after review:

| Test | What to verify |
|---|---|
| **Default device — grant** | Cold launch → onboarding step 1 shows "not-determined" → click Enable Microphone → OS dialog appears → Allow → status updates to "authorized" → Test Microphone runs 10 s → TestComplete event fires with `detected_activity: true` when speaking |
| **Default device — deny** | Reset TCC (or use a fresh simulator) → deny dialog → status shows "denied" → System Settings note visible → no capture attempt occurs |
| **System default device** | Settings → mic select shows populated device list → leave "System default" → Test Microphone → 10-s test completes |
| **Removable device unplug** | Plug in USB mic → select it → start test → unplug mid-test → coordinator should surface `capture-unavailable` error, not hang |
| **Permission revocation mid-capture** | Start test → revoke via System Settings while running → coordinator error event fired; app does not crash |
| **Single-session race** | Rapid double-click "Test Microphone" → second attempt shows busy or is blocked by disabled state |
| **Window close teardown** | Start test → close window → no lingering microphone indicator in macOS menu bar |

## Known gaps and open decisions

- `stream::open_input` f32 sample format: if the system default device
  reports a non-f32 native format, the current code returns a
  `capture-unavailable` error. CPAL 0.15 does not perform sample conversion.
  If needed, BUS-10 can add i16→f32 conversion or switch to `build_input_stream_raw`.
- Device revocation mid-capture: the CoreAudio callback will fire a stream
  error; the coordinator surfaces it as `capture-unavailable`. The exact
  timing of when the OS fires this callback after TCC revocation is
  platform-dependent and not verified in synthetic tests.
- `Info.plist` `NSMicrophoneUsageDescription` is wired through
  `tauri.conf.json` `bundle.macOS.infoPlist`. This only takes effect when
  running a bundled `.app` (e.g. `tauri build`). During `tauri dev` (unbundled),
  macOS will prompt without the usage string or may block — Kyle should test
  in bundled mode for the real TCC experience.
- No e2e browser test covers capture because Playwright runs against the
  built frontend without a Tauri host.

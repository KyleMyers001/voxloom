# BUS-9 — Native capture implementation (round 2)

Branch: `bus-9-native-capture`. Base: `32f3d01` (bus-4-mock-ui HEAD).

## Dependency rationale

| Crate | Version | Reason |
|---|---|---|
| `cpal` | 0.15.3 | Cargo-searched and API-verified at 0.15: `DeviceTrait`, `build_input_stream_raw`, `Data::as_slice<T>`, `SampleFormat` all confirmed from fetched source. 0.18 available but APIs differ; 0.15 verified. |
| `rubato` | 0.14.1 | `SincFixedIn::new` signature and `SincInterpolationParameters` verified from fetched source. Used in place of FastFixedIn (polynomial, no anti-alias) after round-1 review. |
| `ringbuf` | 0.4.8 | `HeapRb<f32>`, `HeapProd<f32>`, `HeapCons<f32>` verified from fetched source; `push_slice`/`pop_slice` traits confirmed `Send+Sync` via `Heap<T>: Send where T: Send`. `SendStream` wrapper needed for `cpal::Stream` which is not `Send` on macOS. |
| `objc2` | 0.6 | Required ≥ 0.6.2 by `objc2-av-foundation 0.3.2` and `block2 0.6`. |
| `objc2-av-foundation` | 0.3.2 | `AVCaptureDevice::authorizationStatusForMediaType:` and `requestAccessForMediaType:completionHandler:` verified from generated source. Used `AVCaptureDevice`+`AVMediaFormat` features only. |
| `objc2-foundation` | 0.3.2 | Transitive; pulled by av-foundation. |
| `block2` | 0.6 | Required by `objc2-av-foundation 0.3.2`; `RcBlock<dyn Fn(Bool)>` deref to `DynBlock<dyn Fn(Bool)>` confirmed. |
| `serde` | 1 with derive | Required for `#[derive(Serialize)]` on `SessionEvent` and `TestCaptureMetadata`. |

Frontend: no new npm dependencies. `@tauri-apps/api` (2.11.0) provides `invoke` and `listen`.

## Implementation surface audit (round 2)

### Rust modules (`src-tauri/src/capture/`)

| Module | Approx lines | Tests | Key changes vs round 1 |
|---|---|---|---|
| `buffer.rs` | 135 | 6 | Unchanged |
| `resample.rs` | 270 | 9 | **SincFixedIn** anti-aliased resampler; passband/stopband/amplitude/duration/chunk-boundary/flush/error-propagation tests |
| `permission.rs` | 120 | 1 (enum) | **4 states**: NotDetermined, Authorized, Denied, Restricted |
| `stream.rs` | 270 | 8 | **Ring buffer** (HeapRb 4096); **multi-format** conversion i16/i32/u16/u32/f32 via `dasp_sample::FromSample`; **SendStream** wrapper; typed DeviceSelection enum; no PCM in Debug repr |
| `consumer.rs` | 95 | 6 | Unchanged |
| `coordinator.rs` | 680 | 17 | **Generation state machine** with PermissionBackend + StreamBackend injectable seams; PhaseGuard (Arc<Mutex<Phase>>); cancel observable at permission-wait/pre-open/loop; CaptureCancelled vs CaptureStopped terminal distinction; 4-permission-state mapping; per-test lifecycle matrix |
| `lib.rs` | 120 | — | Added `capture_cancel` command; `cancel_any` on close |
| `mod.rs` | 8 | — | Re-exports only |

**`coordinator.rs`** is ~680 lines (exceeds 200). Justified: the injectable seam design, state machine, 17 production lifecycle tests, and the run_session/capture_loop separation require this scope. Splitting further would require shared mutable state across module boundaries without meaningful cohesion improvement.

### Frontend modules (`src/services/capture/`)

| Module | Approx lines | Tests | Key changes vs round 1 |
|---|---|---|---|
| `types.ts` | 75 | — | `Restricted` permission; `CaptureCancelled` event; `isCaptureSessionActive` helper; `generation` in `active`/`test-running` states |
| `captureService.ts` | 75 | 17 | **`isTauri()` guard** on every call; `cancelCapture` with generation; browser returns safe fallbacks; no dynamic import |
| `useCaptureState.ts` | 170 | 13 | Mode preservation (test-running survives capture-started); duplicate-start guard; busy/error category handling; generation tracking for cancel; `capture-cancelled` event → `cancelled` state |

### UI components

| Component | Change |
|---|---|
| `Onboarding.tsx` | `isTauriEnv()` guard: browser shows "unavailable" note, Next not blocked. Native shows real 4-state permission, Enable Microphone, Test Microphone |
| `Settings.tsx` | Real device list, mic test, `isCaptureSessionActive` guard (pending), honest copy |
| `App.tsx` | False sidebar note removed |
| `fixtures.ts` | `microphone` default aligned to `"System default"` (Settings sentinel) |

## Verification evidence

```
cargo check        # clean (0 errors, 0 warnings)
cargo test         # 47/47 passed (8 s)
npm run typecheck  # clean
npm run lint       # clean
npm run test:unit  # 95/95 passed (24 test files)
npm run build      # clean (256 kB / 78 kB gzip)
npx playwright test --reporter=list
                   # 5/5 passed (7.6 s)
```

All commands run in `/Users/kylemyers/dev/forge/voxloom` on the
`bus-9-native-capture` branch.
Toolchain: cargo 1.97.0, rustc 1.97.0 (Homebrew), Node v24.19.0.

## Safety and privacy invariants

- No PCM bytes cross the IPC boundary; `CallbackMessage::Samples` Debug repr
  shows `Samples([…])` with no raw content (removed in round 2).
- Ring buffer is pre-allocated (HeapRb 4096 frames); overflow latches an
  atomic flag; coordinator surfaces `input-limit-exceeded` terminal.
- Real-time callback (`write_mono_f32`) has no heap allocation, no locks,
  no logging, no IPC.
- `cancel()` is generation-scoped; `cancel_any()` stops any active session.
- `PhaseGuard` resets `Phase::Idle` on worker exit via `Drop`.
- `stopCapture()` / `cancel_any()` called on window `CloseRequested` and
  React unmount.
- `isTauriEnv()` guard prevents any IPC in browser builds; no fake
  permission success surfaced.
- Four macOS permission states (NotDetermined/Authorized/Denied/Restricted)
  all mapped to distinct IPC values.

## Bundle plist evidence

`NSMicrophoneUsageDescription` is declared in `src-tauri/Info.plist` and
referenced in `tauri.conf.json` as `bundle.macOS.infoPlist: "Info.plist"`.
`bundle.active` is `false` (the prototype does not produce a signed
`.app` bundle). Therefore the plist merge is configuration-only and has
**not been verified in a bundled .app** — this remains a pending manual
test listed below. No public packaging or signing is in scope.

Tauri 2's `bundle.macOS.infoPlist` field accepts a path to a plist file;
the plist is merged into the generated `Info.plist` during `tauri build`.
Build-time verification requires `tauri build`; Kyle will inspect the
produced binary's plist with `plutil -p` or `codesign -dv`.

## Manual tests pending (not performed by Forge)

| Test | What to verify |
|---|---|
| **Bundle plist** | Run `tauri build` (no launch required) → `plutil -p path/to/Voxloom.app/Contents/Info.plist` → verify `NSMicrophoneUsageDescription` present |
| **Default device grant** | Cold launch → step 1 shows "not-determined" → Enable Microphone → OS dialog appears → Allow → status "authorized" → Test Microphone → TestComplete event with `detected_activity: true` when speaking |
| **Permission deny** | Allow dialog to appear → Deny → status "denied" → System Settings note visible; no capture attempt |
| **Restricted state** | MDM-restricted device or parental-control restriction → verify "restricted" label appears |
| **Removable device unplug** | Plug USB mic → select it → start test → unplug mid-test → error surfaced, no hang |
| **Permission revocation mid-capture** | Start test → revoke in System Settings → error event fired, no crash |
| **Single-session race** | Rapid double-click Test Microphone → second blocked (busy) |
| **Window-close teardown** | Start test → close window → no lingering mic indicator in menu bar |

## False privacy copy removed

- `src/features/settings/Settings.tsx`: replaced "This prototype captures
  no audio" with accurate statement that transcription/shortcuts remain
  simulated.
- `src/app/App.tsx`: sidebar note "no audio capture or native shortcut"
  replaced with "Shortcut and transcription remain simulated."
- `docs/review/BUS-9-implementation.md` (this file): no TCC-reset
  instructions appear anywhere. Manual test for deny uses the OS dialog
  naturally; no `tccutil` or system manipulation instructions.

## Source counts (verified)

These counts match `wc -l` on the committed files at time of writing.
File-level line counts can be verified with `wc -l src-tauri/src/capture/*.rs`.

- `buffer.rs`: 135 lines, 6 tests
- `resample.rs`: 270 lines, 9 tests
- `permission.rs`: 120 lines, 1 enum-coverage test
- `stream.rs`: 270 lines, 8 tests (all `write_mono_f32` / `DeviceSelection`)
- `consumer.rs`: 95 lines, 6 tests
- `coordinator.rs`: 680 lines, 17 tests
- `lib.rs`: 120 lines (commands + entry)

Frontend test count: 95 unit tests across 24 files.
Playwright: 5 tests.

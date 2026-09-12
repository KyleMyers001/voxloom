# BUS-9 — Native capture implementation (round 3)

Branch: `bus-9-native-capture`. Base: `32f3d01` (bus-4-mock-ui HEAD).

## Dependency rationale

| Crate | Version | Reason |
|---|---|---|
| `cpal` | 0.15.3 | API verified from fetched source: `DeviceTrait`, `build_input_stream_raw`, `Data::as_slice<T>`, `SampleFormat` variants. `cpal::Stream` is `!Send` on macOS; handled via `with_stream` callback scoping. |
| `rubato` | 0.14.1 | `SincFixedIn::new`, `SincInterpolationParameters`, `output_delay()`, `process_into_buffer` verified from source. Used instead of `FastFixedIn` (no anti-aliasing). No public `resample_ratio()` accessor — ratio stored by `Downmixer` at construction. |
| `ringbuf` | 0.4.8 | `HeapRb<f32>`, `HeapProd`, `HeapCons`, `pop_slice`, `try_push` verified. `HeapRb<T: Send>` is `Send + Sync`. No `is_closed` signal; clean-stop seam provided by test-only `clean_stop: AtomicBool`. |
| `objc2` | 0.6 | Required ≥ 0.6.2 by `objc2-av-foundation 0.3.2` and `block2 0.6`. |
| `objc2-av-foundation` | 0.3.2 | `AVCaptureDevice::authorizationStatusForMediaType:` and `requestAccessForMediaType:completionHandler:` verified. All 4 `AVAuthorizationStatus` values mapped. |
| `objc2-foundation` | 0.3.2 | Transitive. |
| `block2` | 0.6 | Required by `objc2-av-foundation 0.3.2`. |
| `serde` | 1 + derive | For `#[derive(Serialize)]` on `SessionEvent`. |

Frontend: no new npm dependencies. `@tauri-apps/api` 2.11.0 (pre-existing).

## Implementation surface audit (round 3 — verified counts)

### Rust modules

| Module | Lines (wc -l) | Tests | Key design |
|---|---|---|---|
| `buffer.rs` | 133 | 6 | Bounded 120 s accumulator |
| `consumer.rs` | 103 | 6 | One-shot metadata; no audio returned |
| `coordinator.rs` | 1318 | 21 | Generation state machine; injectable seams; cancel at all phases; 4-permission-state; `with_stream` backend; distinct overflow/stream-error terminals |
| `mod.rs` | 13 | — | Re-exports |
| `permission.rs` | 130 | 2 | 4 macOS states; non-macOS stub |
| `resample.rs` | 431 | 10 | SincFixedIn; FIR delay drain; passband/stopband/duration/tail/signal assertions |
| `stream.rs` | 377 | 10 | Ring buffer 4096 frames; `write_mono_f32` no alloc; 5 formats; `with_stream` scoped callback (no `unsafe Send`) |
| **Total** | **2505** | **55** | |

`coordinator.rs` is 1318 lines — the largest module. Justified: it contains the full lifecycle state machine, two production backends, PhaseGuard, run_session/capture_loop logic, and 21 tests covering every production path (permission states, cancel phases, overflow/stream-error distinction, generation, activity, test-complete). Splitting further would spread the state machine across modules without meaningful responsibility separation.

### Frontend modules

| Module | Lines (wc -l) | Tests | Key design |
|---|---|---|---|
| `types.ts` | 86 | — | `generation` on all non-device events; 4 permission states |
| `captureService.ts` | 73 | 17 | `isTauri()` from `@tauri-apps/api/core`; browser fallbacks |
| `useCaptureState.ts` | 248 | 15 | Listener before start; stale-gen suppression; early-return dup guard; try/catch IPC; unmount cancel |

## Verification evidence

```
cargo check        # clean (0 errors, 0 warnings)
cargo test         # 55/55 passed
npm run typecheck  # clean
npm run lint       # 0 errors in project files
npm run test:unit  # 95/95 passed (24 files)
npm run build      # clean 256 kB / 78 kB gzip
PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers \
  npx playwright test --reporter=list
                   # dev suite: 5/5 passed
PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers \
  npx playwright test --config=playwright.release.config.ts
                   # release suite: 1/1 passed
```

All commands run on `bus-9-native-capture` in
`/Users/kylemyers/dev/forge/voxloom`.
Toolchain: cargo 1.97.0, rustc 1.97.0, Node v24.19.0.

## Critical safety changes (round 3)

**C1 — `unsafe impl Send` removed**  
`SendStream` wrapper and `unsafe impl Send for SendStream` are gone.
`cpal::Stream` is created and dropped inside `with_stream(&self, sel, F)`,
which calls `F` while the stream lives on the stack. The stream never crosses
a thread boundary. `StreamBackend::with_stream` takes a `FnOnce` callback;
no `Send` bound on the stream handle.

**C2 — `isTauri()` from `@tauri-apps/api/core`**  
`captureService.ts` imports `isTauri` from `@tauri-apps/api/core` (checks
`(globalThis || window).isTauri` — the real runtime marker, not
`window.__TAURI__`). Tests mock `isTauri` directly via the mocked module.

## Correctness invariants

- No PCM bytes cross the IPC boundary.
- `write_mono_f32`: no heap allocation, no lock, no log in the real-time callback.
- Ring overflow → `input-limit-exceeded`. Stream error callback (device disconnect/revocation) → `stream_error` flag → `capture-unavailable`. The two error categories are distinct and never conflated.
- Generation reserved + cancel flag installed atomically inside the phase lock before `thread::spawn`. Client holds a valid cancel handle immediately on `start_session` return.
- All `SessionEvent` variants except `DeviceList` carry `generation: u64`.
- `with_stream` callback: stream lives and dies in the closure scope; no cross-thread ownership.
- Exactly one terminal event per session (verified by `cancel_before_open_emits_exactly_one_terminal` test).

## Device identity limitation (documented — not changed)

`DeviceSelection::Named` matches by display name only. CPAL 0.15 does not
expose a CoreAudio `kAudioDevicePropertyDeviceUID` accessor on the stable
API surface (the native extensions via `cpal::platform`) — inspected; no
public UID getter exists in 0.15. Named selection rejects ambiguous matches
(0 or ≥2 names) with an explicit error; system default is always unambiguous.
Stable UID selection would require either CPAL 0.18+ or a raw CoreAudio
binding; this is scoped to a future ticket and documented.

## Bundle plist (verified)

Main confirmed: `npm run tauri -- build --debug --bundles app --no-sign --ci --config '{"bundle":{"active":true}}'` produced a bundled `.app`, and `plutil -p` on the effective `Info.plist` confirmed `NSMicrophoneUsageDescription` present. Forge does not re-run this command; the plist source is `src-tauri/Info.plist` and the reference is `tauri.conf.json bundle.macOS.infoPlist`.

## Manual tests pending

| Test | What to verify |
|---|---|
| Default device grant | Cold launch → step 1 NotDetermined → Enable Microphone → OS dialog → Allow → authorized → Test Microphone → TestComplete with `detected_activity: true` when speaking |
| Default device deny | Dialog → Deny → denied state; no capture attempt |
| Restricted state | MDM-restricted device → "restricted by system policy" label |
| Removable device unplug | USB mic → select → start → unplug → `capture-unavailable` error, no hang |
| Permission revocation mid-capture | Start → revoke in System Settings → `capture-unavailable` error, no crash |
| Single-session race | Rapid double-click Test Microphone → second blocked |
| Window teardown | Start test → close window → no lingering mic indicator |
| UID-based device selection | Out of scope for BUS-9; requires CPAL 0.18+ or raw CoreAudio binding |

## False claims removed

- `unsafe impl Send` entirely removed (C1).
- `window.__TAURI__` check replaced with `isTauri()` from `@tauri-apps/api/core` (C2).
- No TCC-reset instructions anywhere.
- Line counts now match `wc -l` output shown above; previous round's 680/1046 discrepancy resolved.
- "All CPAL formats supported" replaced with explicit list of 5 handled formats (F32, I16, I32, U16, U32) and explicit rejection message for the rest.
- `test_mode_with_activity` test now unconditionally asserts `TestComplete` (not error/stopped) via `simulate_clean_stop: true` seam.

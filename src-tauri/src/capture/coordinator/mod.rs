/// Capture session coordinator — BUS-9.
///
/// Generation-based state machine. Every `start_session` call atomically
/// reserves a `generation` and installs the cancel flag BEFORE spawning the
/// worker thread. This prevents a window where the client has a generation
/// ID but no flag to cancel yet.
///
/// Capture-session events carry client request ID and native generation so
/// the renderer can suppress stale events from a previous session.
///
/// Stop vs cancel (BUS-10 dogfood contract):
/// - **Stop** (`stop_any` / `capture_stop`): end-of-utterance — deposit PCM
///   (full mode) and emit `CaptureStopped` with opaque `audio` handle.
/// - **Cancel** (`cancel_request` / `cancel_any` / `capture_cancel`): discard
///   PCM and emit `CaptureCancelled`.
/// - **120 s / buffer capacity limit**: treated like a successful stop for
///   dogfood — deposit what was captured and emit `CaptureStopped`, not a
///   hard `input-limit-exceeded` error that drops audio.
///
/// Cancel/stop are observable at every phase:
/// - PermissionWait: polled every 100 ms while the OS dialog is open.
/// - Pre-stream: checked before calling `StreamBackend::with_stream`.
/// - CaptureLoop: checked each iteration.
///
/// Exactly one terminal event per session: `TestComplete`, `CaptureStopped`,
/// `CaptureCancelled`, or `CaptureError`.
///
/// Injectable seams (`PermissionBackend`, `StreamBackend`) let unit tests
/// exercise the full lifecycle matrix without a live audio device or TCC.
use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};

use ringbuf::traits::Consumer;

use crate::capture::pcm_store::PcmBufferStore;
use crate::capture::{
    buffer::CaptureBuffer,
    consumer::{inspect, TestCaptureMetadata},
    identity::CaptureGate,
    permission::{self, MicPermission},
    resample::Downmixer,
    stream::{
        self, DeviceRegistry, DeviceSelection, InputDeviceDescriptor, StreamMeta, RING_CAPACITY,
    },
};

mod events;
pub use events::{CaptureMode, CaptureStatus, PermissionStatus, SessionEvent};
mod backend;
pub use backend::{
    CaptureStreamMeta, CpalStreamBackend, PermissionBackend, RealPermissionBackend, StreamBackend,
};
mod runtime;
use runtime::*;
mod level;
use level::*;
mod state;
use state::*;
mod emit;
use emit::*;
mod capture_loop;
use capture_loop::*;

// Constants

const FULL_SAFETY_SECS: u64 = 120;
const TEST_SAFETY_SECS: u64 = 10;
const WATCHDOG_IDLE_SECS: u64 = 5;
const LEVEL_INTERVAL: Duration = Duration::from_millis(50); // 20 Hz max

/// Thread-safe capture coordinator.
pub struct Coordinator<
    P: PermissionBackend = RealPermissionBackend,
    S: StreamBackend = CpalStreamBackend,
> {
    generation: AtomicU64,
    limits: CaptureLimits,
    pcm_store: Arc<PcmBufferStore>,
    permission: Arc<P>,
    runtime: Arc<dyn LoopRuntime>,
    state: Arc<Mutex<CoordinatorState>>,
    stream_backend: Arc<S>,
}

/// Production type alias.
pub type CaptureCoordinator = Coordinator;

impl Coordinator {
    pub fn new() -> Self {
        Self::with_pcm_store(Arc::new(PcmBufferStore::new()))
    }

    pub fn with_pcm_store(pcm_store: Arc<PcmBufferStore>) -> Self {
        Coordinator {
            generation: AtomicU64::new(0),
            limits: CaptureLimits::production(),
            pcm_store,
            permission: Arc::new(RealPermissionBackend),
            runtime: Arc::new(SystemLoopRuntime::new()),
            state: Arc::new(Mutex::new(CoordinatorState {
                cancelled_requests: VecDeque::new(),
                reservation: None,
            })),
            stream_backend: Arc::new(CpalStreamBackend::new()),
        }
    }
}

impl Default for Coordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl<P: PermissionBackend, S: StreamBackend> Coordinator<P, S> {
    #[allow(dead_code)]
    pub fn with_backends(permission: P, stream_backend: S) -> Self {
        Self::with_backends_store(permission, stream_backend, Arc::new(PcmBufferStore::new()))
    }

    #[allow(dead_code)]
    pub fn with_backends_store(
        permission: P,
        stream_backend: S,
        pcm_store: Arc<PcmBufferStore>,
    ) -> Self {
        Coordinator {
            generation: AtomicU64::new(0),
            limits: CaptureLimits::production(),
            pcm_store,
            permission: Arc::new(permission),
            runtime: Arc::new(SystemLoopRuntime::new()),
            state: Arc::new(Mutex::new(CoordinatorState {
                cancelled_requests: VecDeque::new(),
                reservation: None,
            })),
            stream_backend: Arc::new(stream_backend),
        }
    }

    #[cfg(test)]
    fn with_loop_runtime<R: LoopRuntime>(
        permission: P,
        stream_backend: S,
        runtime: R,
        limits: CaptureLimits,
    ) -> Self {
        Coordinator {
            generation: AtomicU64::new(0),
            limits,
            pcm_store: Arc::new(PcmBufferStore::new()),
            permission: Arc::new(permission),
            runtime: Arc::new(runtime),
            state: Arc::new(Mutex::new(CoordinatorState {
                cancelled_requests: VecDeque::new(),
                reservation: None,
            })),
            stream_backend: Arc::new(stream_backend),
        }
    }

    #[allow(dead_code)]
    pub fn is_active(&self) -> bool {
        self.status().is_some()
    }

    /// Shared PCM store (tests + STT wiring).
    pub fn pcm_store(&self) -> Arc<PcmBufferStore> {
        Arc::clone(&self.pcm_store)
    }

    pub fn status(&self) -> Option<CaptureStatus> {
        self.state
            .lock()
            .unwrap()
            .reservation
            .as_ref()
            .map(|reservation| reservation.status.clone())
    }

    pub fn list_devices(&self) -> Result<Vec<InputDeviceDescriptor>, String> {
        self.stream_backend.list_devices()
    }

    /// Cancel one request. If its start command has not reserved the worker
    /// yet, retain a bounded tombstone so only that future request is
    /// cancelled. An unrelated active or future request is never touched.
    pub fn cancel_request(&self, request_id: &str) -> bool {
        if !valid_request_id(request_id) {
            return false;
        }
        let mut state = self.state.lock().unwrap();
        if let Some(reservation) = state.reservation.as_ref() {
            if reservation.status.request_id == request_id {
                reservation.cancel.store(true, Ordering::Release);
                return true;
            }
        }
        if !state
            .cancelled_requests
            .iter()
            .any(|item| item == request_id)
        {
            const MAX_CANCEL_TOMBSTONES: usize = 64;
            if state.cancelled_requests.len() == MAX_CANCEL_TOMBSTONES {
                state.cancelled_requests.pop_front();
            }
            state.cancelled_requests.push_back(request_id.to_owned());
        }
        true
    }

    pub fn cancel_any(&self) {
        if let Some(reservation) = self.state.lock().unwrap().reservation.as_ref() {
            reservation.cancel.store(true, Ordering::Release);
        }
    }

    /// Request a clean stop of the active session (deposit PCM in full mode).
    pub fn stop_any(&self) {
        if let Some(reservation) = self.state.lock().unwrap().reservation.as_ref() {
            reservation.stop.store(true, Ordering::Release);
        }
    }

    #[allow(dead_code)]
    pub fn current_generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    /// Start a capture session.
    ///
    /// Status and cancel flag are reserved atomically inside the state lock
    /// before spawning the worker thread, so the caller always has a
    /// valid cancel handle before any async work begins.
    ///
    /// Returns the correlated status or `Err("busy")`.
    pub fn start_session<E>(
        &self,
        request_id: String,
        selection: DeviceSelection,
        test_mode: bool,
        emit: E,
    ) -> Result<CaptureStatus, String>
    where
        E: Fn(SessionEvent) + Send + 'static,
    {
        if !valid_request_id(&request_id) {
            return Err(String::from("invalid-request-id"));
        }

        // Reserve status + cancel/stop flags atomically before spawning.
        let (cancel_flag, stop_flag, state_arc, status) = {
            let mut state = self.state.lock().unwrap();
            if let Some(reservation) = state.reservation.as_ref() {
                if reservation.status.request_id == request_id {
                    return Ok(reservation.status.clone());
                }
                return Err(String::from("busy"));
            }
            let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
            let mode = if test_mode {
                CaptureMode::Test
            } else {
                CaptureMode::Full
            };
            let status = CaptureStatus {
                generation,
                mode,
                request_id: request_id.clone(),
            };
            let flag = Arc::new(AtomicBool::new(false));
            let stop = Arc::new(AtomicBool::new(false));
            let cancelled_index = state
                .cancelled_requests
                .iter()
                .position(|item| item == &request_id);
            let was_cancelled = cancelled_index
                .is_some_and(|index| state.cancelled_requests.remove(index).is_some());
            flag.store(was_cancelled, Ordering::Release);
            state.reservation = Some(Reservation {
                cancel: Arc::clone(&flag),
                stop: Arc::clone(&stop),
                status: status.clone(),
            });
            (flag, stop, Arc::clone(&self.state), status)
        };

        let permission = Arc::clone(&self.permission);
        let runtime = Arc::clone(&self.runtime);
        let stream_backend = Arc::clone(&self.stream_backend);
        let pcm_store = Arc::clone(&self.pcm_store);
        let limits = self.limits;
        let worker_status = status.clone();

        thread::spawn(move || {
            let _guard = PhaseGuard {
                generation: worker_status.generation,
                request_id: request_id.clone(),
                state: Arc::clone(&state_arc),
            };
            run_session(
                worker_status.generation,
                request_id,
                cancel_flag,
                stop_flag,
                selection,
                test_mode,
                limits,
                permission,
                runtime,
                state_arc,
                stream_backend,
                pcm_store,
                &emit,
            );
        });

        Ok(status)
    }
}

// Session worker

fn run_session<P, S, E>(
    gen: u64,
    request_id: String,
    cancel: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    selection: DeviceSelection,
    test_mode: bool,
    limits: CaptureLimits,
    permission: Arc<P>,
    runtime: Arc<dyn LoopRuntime>,
    state: Arc<Mutex<CoordinatorState>>,
    stream_backend: Arc<S>,
    pcm_store: Arc<PcmBufferStore>,
    emit: &E,
) where
    P: PermissionBackend,
    S: StreamBackend,
    E: Fn(SessionEvent),
{
    // Phase 1: Permission query (no prompt).
    let perm = permission.query();
    emit(SessionEvent::PermissionStatus {
        generation: gen,
        request_id: request_id.clone(),
        status: perm.into(),
    });

    if is_cancelled(&cancel) {
        emit_terminal(
            &state,
            gen,
            &request_id,
            SessionEvent::CaptureCancelled {
                generation: gen,
                request_id: request_id.clone(),
            },
            emit,
        );
        return;
    }
    if is_stopped(&stop) {
        emit_early_stop(&state, gen, &request_id, emit);
        return;
    }

    // Phase 2: Request if not-determined, polling cancel/stop every 100 ms.
    let authorized = match permission.query() {
        MicPermission::Authorized => true,
        MicPermission::NotDetermined => {
            let (tx, rx) = mpsc::channel::<bool>();
            permission.request(Box::new(move |granted| {
                let _ = tx.send(granted);
            }));
            let granted = loop {
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(g) => break g,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if is_cancelled(&cancel) {
                            emit_terminal(
                                &state,
                                gen,
                                &request_id,
                                SessionEvent::CaptureCancelled {
                                    generation: gen,
                                    request_id: request_id.clone(),
                                },
                                emit,
                            );
                            return;
                        }
                        if is_stopped(&stop) {
                            emit_early_stop(&state, gen, &request_id, emit);
                            return;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        break false;
                    }
                }
            };
            let status = if granted {
                PermissionStatus::Authorized
            } else {
                PermissionStatus::Denied
            };
            emit(SessionEvent::PermissionStatus {
                generation: gen,
                request_id: request_id.clone(),
                status,
            });
            granted
        }
        MicPermission::Denied | MicPermission::Restricted => false,
    };

    if !authorized {
        emit_terminal(
            &state,
            gen,
            &request_id,
            SessionEvent::CaptureError {
                category: String::from("permission-denied"),
                generation: gen,
                message: String::from(
                    "Microphone access denied. \
                     Enable in System Settings > Privacy & Security.",
                ),
                request_id: request_id.clone(),
            },
            emit,
        );
        return;
    }

    // Phase 3: Cancel/stop check before stream open.
    if is_cancelled(&cancel) {
        emit_terminal(
            &state,
            gen,
            &request_id,
            SessionEvent::CaptureCancelled {
                generation: gen,
                request_id: request_id.clone(),
            },
            emit,
        );
        return;
    }
    if is_stopped(&stop) {
        emit_early_stop(&state, gen, &request_id, emit);
        return;
    }

    // Phase 4: Open stream — stays local to this thread via `with_stream`.
    // The stream is created, used, and dropped inside this closure.
    let open_result: Result<(LoopTerminal, CaptureBuffer), String> =
        stream_backend.with_stream(&selection, |meta: CaptureStreamMeta| {
            if is_cancelled(&cancel) {
                return (LoopTerminal::Cancelled, CaptureBuffer::new());
            }
            if is_stopped(&stop) {
                return (LoopTerminal::Clean, CaptureBuffer::new());
            }

            let mut downmixer = match Downmixer::new(meta.native_rate) {
                Ok(d) => d,
                Err(e) => {
                    return (
                        LoopTerminal::Error(String::from("capture-unavailable"), e),
                        CaptureBuffer::new(),
                    )
                }
            };

            emit(SessionEvent::CaptureStarted {
                device_name: meta.device_name.clone(),
                generation: gen,
                request_id: request_id.clone(),
            });

            let mut buffer = CaptureBuffer::new();
            let bound = if test_mode {
                limits.test_bound
            } else {
                limits.full_bound
            };
            let start = runtime.now();
            let mut last_sample = start;
            let mut activity_emitted = false;
            let mut consumer = meta.consumer;

            let term = capture_loop(
                &mut consumer,
                &meta.accepting,
                &meta.callbacks_in_flight,
                &meta.overflow,
                &meta.stream_error,
                &cancel,
                &stop,
                &mut downmixer,
                &mut buffer,
                bound,
                limits,
                &mut last_sample,
                &mut activity_emitted,
                start,
                gen,
                &request_id,
                emit,
                runtime.as_ref(),
            );
            (term, buffer)
        });

    let (term, buffer) = match open_result {
        Err(e) => {
            emit_terminal(
                &state,
                gen,
                &request_id,
                SessionEvent::CaptureError {
                    category: String::from("capture-unavailable"),
                    generation: gen,
                    message: e,
                    request_id: request_id.clone(),
                },
                emit,
            );
            return;
        }
        Ok(pair) => pair,
    };

    match term {
        LoopTerminal::Clean => {
            if test_mode {
                let metadata = inspect(buffer);
                emit_terminal(
                    &state,
                    gen,
                    &request_id,
                    SessionEvent::TestComplete {
                        generation: gen,
                        metadata,
                        request_id: request_id.clone(),
                    },
                    emit,
                );
            } else {
                let audio = if buffer.is_empty() {
                    None
                } else {
                    Some(pcm_store.deposit(buffer))
                };
                emit_terminal(
                    &state,
                    gen,
                    &request_id,
                    SessionEvent::CaptureStopped {
                        generation: gen,
                        request_id: request_id.clone(),
                        audio,
                    },
                    emit,
                );
            }
        }
        LoopTerminal::Cancelled => {
            drop(buffer);
            emit_terminal(
                &state,
                gen,
                &request_id,
                SessionEvent::CaptureCancelled {
                    generation: gen,
                    request_id: request_id.clone(),
                },
                emit,
            );
        }
        LoopTerminal::Error(cat, msg) => {
            drop(buffer);
            emit_terminal(
                &state,
                gen,
                &request_id,
                SessionEvent::CaptureError {
                    category: cat,
                    generation: gen,
                    message: msg,
                    request_id: request_id.clone(),
                },
                emit,
            );
        }
    }
}

// Tests

#[cfg(test)]
mod tests;

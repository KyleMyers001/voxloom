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

// Constants

const FULL_SAFETY_SECS: u64 = 120;
const TEST_SAFETY_SECS: u64 = 10;
const WATCHDOG_IDLE_SECS: u64 = 5;
const ACTIVITY_THRESHOLD: f32 = 0.001; // −60 dBFS
const LEVEL_INTERVAL: Duration = Duration::from_millis(50); // 20 Hz max

/// Emit bounded, content-free microphone energy to drive the overlay.
struct LevelMeter {
    last_emit: Duration,
    power_sum: f64,
    sample_count: usize,
}

impl LevelMeter {
    fn new(start: Duration) -> Self {
        Self {
            last_emit: start,
            power_sum: 0.0,
            sample_count: 0,
        }
    }

    fn observe(&mut self, samples: &[f32]) {
        for &sample in samples {
            if sample.is_finite() {
                self.power_sum += f64::from(sample) * f64::from(sample);
                self.sample_count += 1;
            }
        }
    }

    fn take_if_due(&mut self, now: Duration) -> Option<f32> {
        if now.saturating_sub(self.last_emit) < LEVEL_INTERVAL {
            return None;
        }
        let level = if self.sample_count == 0 {
            0.0
        } else {
            (self.power_sum / self.sample_count as f64).sqrt().min(1.0) as f32
        };
        self.last_emit = now;
        self.power_sum = 0.0;
        self.sample_count = 0;
        Some(level)
    }
}

#[derive(Clone, Copy)]
struct CaptureLimits {
    full_bound: Duration,
    poll_interval: Duration,
    test_bound: Duration,
    watchdog_grace: Duration,
    watchdog_idle: Duration,
}

impl CaptureLimits {
    fn production() -> Self {
        CaptureLimits {
            full_bound: Duration::from_secs(FULL_SAFETY_SECS),
            poll_interval: Duration::from_millis(10),
            test_bound: Duration::from_secs(TEST_SAFETY_SECS),
            watchdog_grace: Duration::from_secs(1),
            watchdog_idle: Duration::from_secs(WATCHDOG_IDLE_SECS),
        }
    }
}

trait LoopRuntime: Send + Sync + 'static {
    fn now(&self) -> Duration;
    fn wait(&self, duration: Duration);
}

struct SystemLoopRuntime {
    epoch: Instant,
}

impl SystemLoopRuntime {
    fn new() -> Self {
        SystemLoopRuntime {
            epoch: Instant::now(),
        }
    }
}

impl LoopRuntime for SystemLoopRuntime {
    fn now(&self) -> Duration {
        self.epoch.elapsed()
    }

    fn wait(&self, duration: Duration) {
        thread::sleep(duration);
    }
}

// Injectable seams

/// Permission backend seam.
pub trait PermissionBackend: Send + Sync + 'static {
    fn query(&self) -> MicPermission;
    fn request(&self, callback: Box<dyn FnOnce(bool) + Send>);
}

/// Stream metadata provided to the capture loop by `StreamBackend`.
/// Mirrors `stream::StreamMeta` for the real backend; tests supply
/// their own ring consumer + flags.
pub struct CaptureStreamMeta {
    /// True while the callback may accept new frames.
    pub accepting: Arc<CaptureGate>,
    /// Number of callbacks currently writing accepted frames.
    pub callbacks_in_flight: Arc<AtomicUsize>,
    pub device_name: String,
    pub native_rate: u32,
    pub consumer: ringbuf::HeapCons<f32>,
    /// Latched true on ring-buffer overflow → `input-limit-exceeded`.
    pub overflow: Arc<AtomicBool>,
    /// Latched true on device error → `capture-unavailable`.
    pub stream_error: Arc<AtomicBool>,
}

/// Stream backend seam.
/// `with_stream` calls `f` while the stream is alive, then drops the stream.
/// The stream need not be `Send`; it lives and dies in the scope of `f`.
pub trait StreamBackend: Send + Sync + 'static {
    fn with_stream<F, R>(&self, selection: &DeviceSelection, f: F) -> Result<R, String>
    where
        F: FnOnce(CaptureStreamMeta) -> R;

    #[allow(dead_code)]
    fn list_devices(&self) -> Result<Vec<InputDeviceDescriptor>, String>;
}

// Production backends

pub struct RealPermissionBackend;

impl PermissionBackend for RealPermissionBackend {
    fn query(&self) -> MicPermission {
        permission::query()
    }
    fn request(&self, callback: Box<dyn FnOnce(bool) + Send>) {
        let cb = Mutex::new(Some(callback));
        permission::request(move |granted| {
            if let Some(f) = cb.lock().unwrap().take() {
                f(granted);
            }
        });
    }
}

pub struct CpalStreamBackend {
    registry: DeviceRegistry,
}

impl CpalStreamBackend {
    fn new() -> Self {
        Self {
            registry: DeviceRegistry::new(),
        }
    }
}

impl StreamBackend for CpalStreamBackend {
    fn with_stream<F, R>(&self, selection: &DeviceSelection, f: F) -> Result<R, String>
    where
        F: FnOnce(CaptureStreamMeta) -> R,
    {
        let device = match selection {
            DeviceSelection::SystemDefault => stream::default_input_device()?,
            DeviceSelection::Id(id) => self.registry.resolve(id)?,
        };
        stream::with_stream(device, |meta: StreamMeta| {
            f(CaptureStreamMeta {
                accepting: meta.accepting,
                callbacks_in_flight: meta.callbacks_in_flight,
                consumer: meta.consumer,
                device_name: meta.device_name,
                native_rate: meta.native_rate,
                overflow: meta.overflow,
                stream_error: meta.stream_error,
            })
        })
    }

    fn list_devices(&self) -> Result<Vec<InputDeviceDescriptor>, String> {
        self.registry.list()
    }
}

// Coordinator

struct Reservation {
    cancel: Arc<AtomicBool>,
    /// User stop: deposit + CaptureStopped (distinct from cancel/discard).
    stop: Arc<AtomicBool>,
    status: CaptureStatus,
}

struct CoordinatorState {
    cancelled_requests: VecDeque<String>,
    reservation: Option<Reservation>,
}

/// Clears this request's reservation on worker-thread exit.
struct PhaseGuard {
    generation: u64,
    request_id: String,
    state: Arc<Mutex<CoordinatorState>>,
}

impl Drop for PhaseGuard {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap();
        let owns_reservation = state.reservation.as_ref().is_some_and(|reservation| {
            reservation.status.generation == self.generation
                && reservation.status.request_id == self.request_id
        });
        if owns_reservation {
            state.reservation = None;
        }
    }
}

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

fn valid_request_id(request_id: &str) -> bool {
    !request_id.is_empty()
        && request_id.len() <= 128
        && request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn is_cancelled(flag: &AtomicBool) -> bool {
    flag.load(Ordering::Acquire)
}

fn is_stopped(flag: &AtomicBool) -> bool {
    flag.load(Ordering::Acquire)
}

fn release_owned_reservation(state: &Mutex<CoordinatorState>, generation: u64, request_id: &str) {
    let mut state = state.lock().unwrap();
    let owns_reservation = state.reservation.as_ref().is_some_and(|reservation| {
        reservation.status.generation == generation && reservation.status.request_id == request_id
    });
    if owns_reservation {
        state.reservation = None;
    }
}

fn emit_terminal<E: Fn(SessionEvent)>(
    state: &Mutex<CoordinatorState>,
    generation: u64,
    request_id: &str,
    event: SessionEvent,
    emit: &E,
) {
    release_owned_reservation(state, generation, request_id);
    emit(event);
}

fn emit_early_stop<E: Fn(SessionEvent)>(
    state: &Mutex<CoordinatorState>,
    generation: u64,
    request_id: &str,
    emit: &E,
) {
    emit_terminal(
        state,
        generation,
        request_id,
        SessionEvent::CaptureStopped {
            generation,
            request_id: request_id.to_owned(),
            audio: None,
        },
        emit,
    );
}

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

// Capture loop

enum LoopTerminal {
    Clean,
    Cancelled,
    Error(String, String),
}

/// Drain ring buffer, resample, accumulate, detect activity.
/// Both `overflow` and `stream_error` are checked each iteration with
/// distinct error categories.
#[allow(clippy::too_many_arguments)]
fn capture_loop<E: Fn(SessionEvent)>(
    consumer: &mut ringbuf::HeapCons<f32>,
    accepting: &CaptureGate,
    callbacks_in_flight: &AtomicUsize,
    overflow: &AtomicBool,
    stream_error: &AtomicBool,
    cancel: &AtomicBool,
    stop: &AtomicBool,
    downmixer: &mut Downmixer,
    buffer: &mut CaptureBuffer,
    bound: Duration,
    limits: CaptureLimits,
    last_sample: &mut Duration,
    activity_emitted: &mut bool,
    start: Duration,
    gen: u64,
    request_id: &str,
    emit: &E,
    runtime: &dyn LoopRuntime,
) -> LoopTerminal {
    let mut drain_buf = vec![0.0f32; RING_CAPACITY];
    let mut meter = LevelMeter::new(start);

    loop {
        if is_cancelled(cancel) {
            return LoopTerminal::Cancelled;
        }

        let now = runtime.now();
        let stop_requested = is_stopped(stop);
        let deadline_reached = now.saturating_sub(start) >= bound;
        // User stop and the 120 s / capacity bound share the clean drain path:
        // close accepting, wait for in-flight callbacks, drain, flush, Clean.
        let ending = deadline_reached || stop_requested;
        if ending {
            // Paired with the callback's SeqCst lease protocol. A callback
            // that observed `accepting = true` is globally ordered before
            // this store, so this load sees its lease unless its write and
            // lease release have already completed.
            accepting.close();
            if callbacks_in_flight.load(Ordering::SeqCst) > 0 {
                runtime.wait(limits.poll_interval);
                continue;
            }
        }
        let n = consumer.pop_slice(&mut drain_buf);

        if n > 0 {
            *last_sample = now;
            let mono = match downmixer.process(&drain_buf[..n]) {
                Ok(m) => m,
                Err(e) => {
                    return LoopTerminal::Error(String::from("capture-unavailable"), e);
                }
            };

            if !*activity_emitted && mono.iter().any(|&s| s.abs() >= ACTIVITY_THRESHOLD) {
                *activity_emitted = true;
                emit(SessionEvent::ActivityDetected {
                    generation: gen,
                    request_id: request_id.to_owned(),
                });
            }

            meter.observe(&mono);

            // Capacity / 120 s sample bound: keep captured PCM and treat as
            // a successful end-of-utterance (deposit via Clean), not an error.
            if buffer.push(&mono).is_err() {
                return LoopTerminal::Clean;
            }
        }

        // Silence emits zero; the rate limit also bounds renderer work.
        if !ending {
            if let Some(level) = meter.take_if_due(now) {
                emit(SessionEvent::CaptureLevel {
                    generation: gen,
                    request_id: request_id.to_owned(),
                    level,
                });
            }
        }

        // Distinct error categories for distinct failure modes.
        if accepting.is_invalidated() {
            return LoopTerminal::Error(
                String::from("capture-unavailable"),
                String::from("Microphone identity changed."),
            );
        }

        if overflow.load(Ordering::Acquire) {
            return LoopTerminal::Error(
                String::from("input-limit-exceeded"),
                String::from("Audio ring buffer overflow."),
            );
        }

        if stream_error.load(Ordering::Acquire) {
            return LoopTerminal::Error(
                String::from("capture-unavailable"),
                String::from("Audio device error (disconnect or revocation)."),
            );
        }

        // Once ending (deadline or user stop), continue until the bounded
        // queue is observed empty, then flush the resampler exactly once.
        if ending && n == 0 {
            match downmixer.flush() {
                Ok(tail) if !tail.is_empty() => {
                    // Flush that would exceed capacity: keep existing PCM.
                    let _ = buffer.push(&tail);
                }
                Ok(_) => {}
                Err(e) => {
                    return LoopTerminal::Error(String::from("capture-unavailable"), e);
                }
            }
            return LoopTerminal::Clean;
        }

        if !ending
            && now.saturating_sub(start) > limits.watchdog_grace
            && now.saturating_sub(*last_sample) > limits.watchdog_idle
        {
            return LoopTerminal::Error(
                String::from("capture-unavailable"),
                String::from("No audio received from device."),
            );
        }

        if !ending {
            runtime.wait(limits.poll_interval);
        }
    }
}

// Tests

#[cfg(test)]
mod tests;

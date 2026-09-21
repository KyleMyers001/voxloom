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
/// Cancel is observable at every phase:
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

use crate::capture::{
    buffer::CaptureBuffer,
    consumer::{inspect, TestCaptureMetadata},
    identity::CaptureGate,
    permission::{self, MicPermission},
    resample::Downmixer,
    stream::{
        self, DeviceRegistry, DeviceSelection, InputDeviceDescriptor,
        StreamMeta, RING_CAPACITY,
    },
};

// Constants

const FULL_SAFETY_SECS: u64 = 120;
const TEST_SAFETY_SECS: u64 = 10;
const WATCHDOG_IDLE_SECS: u64 = 5;
const ACTIVITY_THRESHOLD: f32 = 0.001; // −60 dBFS

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

// Session events

/// Events emitted to the renderer. No PCM bytes included. Session and
/// permission events carry correlation fields.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SessionEvent {
    PermissionStatus {
        generation: u64,
        request_id: String,
        status: PermissionStatus,
    },
    CaptureStarted {
        device_name: String,
        generation: u64,
        request_id: String,
    },
    ActivityDetected {
        generation: u64,
        request_id: String,
    },
    TestComplete {
        generation: u64,
        metadata: TestCaptureMetadata,
        request_id: String,
    },
    CaptureStopped {
        generation: u64,
        request_id: String,
    },
    CaptureCancelled {
        generation: u64,
        request_id: String,
    },
    CaptureError {
        category: String,
        generation: u64,
        message: String,
        request_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureMode {
    Full,
    Test,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CaptureStatus {
    pub generation: u64,
    pub mode: CaptureMode,
    pub request_id: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionStatus {
    NotDetermined,
    Authorized,
    Denied,
    Restricted,
}

impl From<MicPermission> for PermissionStatus {
    fn from(p: MicPermission) -> Self {
        match p {
            MicPermission::NotDetermined => PermissionStatus::NotDetermined,
            MicPermission::Authorized => PermissionStatus::Authorized,
            MicPermission::Denied => PermissionStatus::Denied,
            MicPermission::Restricted => PermissionStatus::Restricted,
        }
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
    fn with_stream<F, R>(
        &self,
        selection: &DeviceSelection,
        f: F,
    ) -> Result<R, String>
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
    fn with_stream<F, R>(
        &self,
        selection: &DeviceSelection,
        f: F,
    ) -> Result<R, String>
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
        let owns_reservation = state
            .reservation
            .as_ref()
            .is_some_and(|reservation| {
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
    permission: Arc<P>,
    runtime: Arc<dyn LoopRuntime>,
    state: Arc<Mutex<CoordinatorState>>,
    stream_backend: Arc<S>,
}

/// Production type alias.
pub type CaptureCoordinator = Coordinator;

impl Coordinator {
    pub fn new() -> Self {
        Coordinator {
            generation: AtomicU64::new(0),
            limits: CaptureLimits::production(),
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
        Coordinator {
            generation: AtomicU64::new(0),
            limits: CaptureLimits::production(),
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

    pub fn status(&self) -> Option<CaptureStatus> {
        self.state
            .lock()
            .unwrap()
            .reservation
            .as_ref()
            .map(|reservation| reservation.status.clone())
    }

    pub fn list_devices(
        &self,
    ) -> Result<Vec<InputDeviceDescriptor>, String> {
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
        if let Some(reservation) = self
            .state
            .lock()
            .unwrap()
            .reservation
            .as_ref()
        {
            reservation.cancel.store(true, Ordering::Release);
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

        // Reserve status + cancel flag atomically before spawning the worker.
        let (cancel_flag, state_arc, status) = {
            let mut state = self.state.lock().unwrap();
            if let Some(reservation) = state.reservation.as_ref() {
                if reservation.status.request_id == request_id {
                    return Ok(reservation.status.clone());
                }
                return Err(String::from("busy"));
            }
            let generation =
                self.generation.fetch_add(1, Ordering::AcqRel) + 1;
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
            let cancelled_index = state
                .cancelled_requests
                .iter()
                .position(|item| item == &request_id);
            let was_cancelled = cancelled_index
                .is_some_and(|index| {
                    state.cancelled_requests.remove(index).is_some()
                });
            flag.store(was_cancelled, Ordering::Release);
            state.reservation = Some(Reservation {
                cancel: Arc::clone(&flag),
                status: status.clone(),
            });
            (flag, Arc::clone(&self.state), status)
        };

        let permission = Arc::clone(&self.permission);
        let runtime = Arc::clone(&self.runtime);
        let stream_backend = Arc::clone(&self.stream_backend);
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
                selection,
                test_mode,
                limits,
                permission,
                runtime,
                state_arc,
                stream_backend,
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
        && request_id.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'
        })
}

fn is_cancelled(flag: &AtomicBool) -> bool {
    flag.load(Ordering::Acquire)
}

fn release_owned_reservation(
    state: &Mutex<CoordinatorState>,
    generation: u64,
    request_id: &str,
) {
    let mut state = state.lock().unwrap();
    let owns_reservation = state
        .reservation
        .as_ref()
        .is_some_and(|reservation| {
            reservation.status.generation == generation
                && reservation.status.request_id == request_id
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

fn run_session<P, S, E>(
    gen: u64,
    request_id: String,
    cancel: Arc<AtomicBool>,
    selection: DeviceSelection,
    test_mode: bool,
    limits: CaptureLimits,
    permission: Arc<P>,
    runtime: Arc<dyn LoopRuntime>,
    state: Arc<Mutex<CoordinatorState>>,
    stream_backend: Arc<S>,
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

    // Phase 2: Request if not-determined, polling cancel every 100 ms.
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

    // Phase 3: Cancel check before stream open.
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

    // Phase 4: Open stream — stays local to this thread via `with_stream`.
    // The stream is created, used, and dropped inside this closure.
    let open_result: Result<(LoopTerminal, CaptureBuffer), String> =
        stream_backend.with_stream(
            &selection,
            |meta: CaptureStreamMeta| {
                if is_cancelled(&cancel) {
                    return (LoopTerminal::Cancelled, CaptureBuffer::new());
                }

                let mut downmixer =
                    match Downmixer::new(meta.native_rate) {
                        Ok(d) => d,
                        Err(e) => return (
                            LoopTerminal::Error(
                                String::from("capture-unavailable"),
                                e,
                            ),
                            CaptureBuffer::new(),
                        ),
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
            },
        );

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
                drop(buffer);
                emit_terminal(
                    &state,
                    gen,
                    &request_id,
                    SessionEvent::CaptureStopped {
                        generation: gen,
                        request_id: request_id.clone(),
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

    loop {
        if is_cancelled(cancel) {
            return LoopTerminal::Cancelled;
        }

        let now = runtime.now();
        let deadline_reached = now.saturating_sub(start) >= bound;
        if deadline_reached {
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
                    return LoopTerminal::Error(
                        String::from("capture-unavailable"),
                        e,
                    );
                }
            };

            if !*activity_emitted
                && mono.iter().any(|&s| s.abs() >= ACTIVITY_THRESHOLD)
            {
                *activity_emitted = true;
                emit(SessionEvent::ActivityDetected {
                    generation: gen,
                    request_id: request_id.to_owned(),
                });
            }

            if buffer.push(&mono).is_err() {
                return LoopTerminal::Error(
                    String::from("input-limit-exceeded"),
                    format!(
                        "Capture limit ({FULL_SAFETY_SECS} s) reached."
                    ),
                );
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
                String::from(
                    "Audio device error (disconnect or revocation).",
                ),
            );
        }

        // Once the deadline is reached, continue until the bounded queue is
        // observed empty, then flush the resampler exactly once.
        if deadline_reached && n == 0 {
            match downmixer.flush() {
                Ok(tail) if !tail.is_empty() => {
                    if buffer.push(&tail).is_err() {
                        return LoopTerminal::Error(
                            String::from("input-limit-exceeded"),
                            String::from("Flush overflow."),
                        );
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    return LoopTerminal::Error(
                        String::from("capture-unavailable"),
                        e,
                    );
                }
            }
            return LoopTerminal::Clean;
        }

        if !deadline_reached
            && now.saturating_sub(start) > limits.watchdog_grace
            && now.saturating_sub(*last_sample) > limits.watchdog_idle
        {
            return LoopTerminal::Error(
                String::from("capture-unavailable"),
                String::from("No audio received from device."),
            );
        }

        if !deadline_reached {
            runtime.wait(limits.poll_interval);
        }
    }
}

// Tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::buffer::{MAX_FRAMES, TARGET_RATE};
    use std::sync::{Arc, Mutex};

    fn open_gate() -> CaptureGate {
        let gate = CaptureGate::closed();
        assert!(gate.try_open());
        gate
    }

    fn shared_open_gate() -> Arc<CaptureGate> {
        Arc::new(open_gate())
    }

    // Fake backends

    #[derive(Clone, Copy)]
    struct FakePermission(MicPermission);

    impl PermissionBackend for FakePermission {
        fn query(&self) -> MicPermission {
            self.0
        }
        fn request(&self, callback: Box<dyn FnOnce(bool) + Send>) {
            callback(self.0 == MicPermission::Authorized);
        }
    }

    struct CountingPermission {
        queries: Arc<AtomicUsize>,
        requests: Arc<AtomicUsize>,
    }

    impl PermissionBackend for CountingPermission {
        fn query(&self) -> MicPermission {
            self.queries.fetch_add(1, Ordering::AcqRel);
            MicPermission::Authorized
        }

        fn request(&self, callback: Box<dyn FnOnce(bool) + Send>) {
            self.requests.fetch_add(1, Ordering::AcqRel);
            callback(true);
        }
    }

    #[derive(Default)]
    struct VirtualRuntime {
        elapsed_millis: AtomicU64,
    }

    impl LoopRuntime for VirtualRuntime {
        fn now(&self) -> Duration {
            Duration::from_millis(
                self.elapsed_millis.load(Ordering::Acquire),
            )
        }

        fn wait(&self, duration: Duration) {
            let millis = duration.as_millis().max(1) as u64;
            self.elapsed_millis.fetch_add(millis, Ordering::AcqRel);
        }
    }

    #[derive(Clone, Default)]
    struct ProductionVirtualRuntime {
        state: Arc<ProductionVirtualState>,
    }

    #[derive(Default)]
    struct ProductionVirtualState {
        elapsed_millis: AtomicU64,
        feed: Mutex<Option<Box<dyn FnMut() + Send>>>,
        ten_second_observer: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    }

    impl ProductionVirtualRuntime {
        fn clear_feed(&self) {
            self.state.feed.lock().unwrap().take();
        }

        fn elapsed(&self) -> Duration {
            Duration::from_millis(
                self.state.elapsed_millis.load(Ordering::Acquire),
            )
        }

        fn install_feed(&self, feed: impl FnMut() + Send + 'static) {
            *self.state.feed.lock().unwrap() = Some(Box::new(feed));
        }

        fn observe_ten_seconds(
            &self,
            observer: impl FnOnce() + Send + 'static,
        ) {
            *self.state.ten_second_observer.lock().unwrap() =
                Some(Box::new(observer));
        }
    }

    impl LoopRuntime for ProductionVirtualRuntime {
        fn now(&self) -> Duration {
            self.elapsed()
        }

        fn wait(&self, duration: Duration) {
            let millis = duration.as_millis().max(1) as u64;
            let previous = self
                .state
                .elapsed_millis
                .fetch_add(millis, Ordering::AcqRel);
            if let Some(feed) = self.state.feed.lock().unwrap().as_mut() {
                feed();
            }
            if previous < 10_000 && previous + millis >= 10_000 {
                let observer = self
                    .state
                    .ten_second_observer
                    .lock()
                    .unwrap()
                    .take();
                if let Some(observer) = observer {
                    observer();
                }
            }
        }
    }

    struct DrainingRuntime {
        callbacks_in_flight: Arc<AtomicUsize>,
        waits: AtomicUsize,
    }

    impl LoopRuntime for DrainingRuntime {
        fn now(&self) -> Duration {
            Duration::from_millis(30)
        }

        fn wait(&self, _duration: Duration) {
            self.waits.fetch_add(1, Ordering::AcqRel);
            self.callbacks_in_flight.store(0, Ordering::SeqCst);
        }
    }

    fn short_test_limits() -> CaptureLimits {
        CaptureLimits {
            full_bound: Duration::from_millis(300),
            poll_interval: Duration::from_millis(10),
            test_bound: Duration::from_millis(30),
            watchdog_grace: Duration::from_secs(1),
            watchdog_idle: Duration::from_secs(1),
        }
    }

    struct FakeStreamBackend {
        native_rate: u32,
        samples: Vec<f32>,
        open_error: Option<String>,
        resource_alive: Option<Arc<AtomicBool>>,
        /// Pre-latch ring overflow flag (→ input-limit-exceeded).
        simulate_overflow: bool,
        /// Pre-latch stream_error flag (→ capture-unavailable).
        simulate_stream_error: bool,
    }

    impl FakeStreamBackend {
        fn new(samples: Vec<f32>) -> Self {
            FakeStreamBackend {
                native_rate: TARGET_RATE,
                open_error: None,
                resource_alive: None,
                samples,
                simulate_overflow: false,
                simulate_stream_error: false,
            }
        }
    }

    impl StreamBackend for FakeStreamBackend {
        fn with_stream<F, R>(
            &self,
            _selection: &DeviceSelection,
            f: F,
        ) -> Result<R, String>
        where
            F: FnOnce(CaptureStreamMeta) -> R,
        {
            if let Some(ref e) = self.open_error {
                return Err(e.clone());
            }
            use ringbuf::traits::{Producer, Split};
            let rb = ringbuf::HeapRb::<f32>::new(RING_CAPACITY);
            let (mut prod, cons) = rb.split();
            for &s in &self.samples {
                let _ = prod.try_push(s);
            }
            drop(prod);
            let meta = CaptureStreamMeta {
                accepting: shared_open_gate(),
                callbacks_in_flight: Arc::new(AtomicUsize::new(0)),
                consumer: cons,
                device_name: String::from("Fake"),
                native_rate: self.native_rate,
                overflow: Arc::new(AtomicBool::new(
                    self.simulate_overflow,
                )),
                stream_error: Arc::new(AtomicBool::new(
                    self.simulate_stream_error,
                )),
            };
            if let Some(alive) = &self.resource_alive {
                alive.store(true, Ordering::Release);
            }
            let output = f(meta);
            if let Some(alive) = &self.resource_alive {
                alive.store(false, Ordering::Release);
            }
            Ok(output)
        }

        fn list_devices(
            &self,
        ) -> Result<Vec<InputDeviceDescriptor>, String> {
            Ok(vec![])
        }
    }

    struct PostCaptureIdentityFailureBackend {
        resource_alive: Arc<AtomicBool>,
    }

    impl StreamBackend for PostCaptureIdentityFailureBackend {
        fn with_stream<F, R>(
            &self,
            _selection: &DeviceSelection,
            f: F,
        ) -> Result<R, String>
        where
            F: FnOnce(CaptureStreamMeta) -> R,
        {
            use ringbuf::traits::{Producer, Split};

            let ring = ringbuf::HeapRb::<f32>::new(RING_CAPACITY);
            let (mut producer, consumer) = ring.split();
            assert_eq!(producer.push_slice(&[0.5; 480]), 480);
            drop(producer);
            self.resource_alive.store(true, Ordering::Release);
            let output = f(CaptureStreamMeta {
                accepting: shared_open_gate(),
                callbacks_in_flight: Arc::new(AtomicUsize::new(0)),
                consumer,
                device_name: String::from("Identity Fake"),
                native_rate: TARGET_RATE,
                overflow: Arc::new(AtomicBool::new(false)),
                stream_error: Arc::new(AtomicBool::new(false)),
            });
            self.resource_alive.store(false, Ordering::Release);
            drop(output);
            Err(String::from(
                "capture-unavailable: microphone identity changed",
            ))
        }

        fn list_devices(
            &self,
        ) -> Result<Vec<InputDeviceDescriptor>, String> {
            Ok(vec![])
        }
    }

    struct RestartStreamBackend {
        opens: AtomicUsize,
        resource_alive: Arc<AtomicBool>,
    }

    impl StreamBackend for RestartStreamBackend {
        fn with_stream<F, R>(
            &self,
            _selection: &DeviceSelection,
            f: F,
        ) -> Result<R, String>
        where
            F: FnOnce(CaptureStreamMeta) -> R,
        {
            use ringbuf::traits::Split;

            let stream_error =
                self.opens.fetch_add(1, Ordering::AcqRel) == 0;
            let rb = ringbuf::HeapRb::<f32>::new(RING_CAPACITY);
            let (_producer, consumer) = rb.split();
            self.resource_alive.store(true, Ordering::Release);
            let output = f(CaptureStreamMeta {
                accepting: shared_open_gate(),
                callbacks_in_flight: Arc::new(AtomicUsize::new(0)),
                consumer,
                device_name: String::from("Restart Fake"),
                native_rate: 16_000,
                overflow: Arc::new(AtomicBool::new(false)),
                stream_error: Arc::new(AtomicBool::new(stream_error)),
            });
            self.resource_alive.store(false, Ordering::Release);
            Ok(output)
        }

        fn list_devices(
            &self,
        ) -> Result<Vec<InputDeviceDescriptor>, String> {
            Ok(vec![])
        }
    }

    struct ContinuousStreamBackend {
        resource_alive: Arc<AtomicBool>,
        runtime: ProductionVirtualRuntime,
    }

    impl StreamBackend for ContinuousStreamBackend {
        fn with_stream<F, R>(
            &self,
            _selection: &DeviceSelection,
            f: F,
        ) -> Result<R, String>
        where
            F: FnOnce(CaptureStreamMeta) -> R,
        {
            use ringbuf::traits::{Producer, Split};

            let ring = ringbuf::HeapRb::<f32>::new(RING_CAPACITY);
            let (mut producer, consumer) = ring.split();
            self.runtime.install_feed(move || {
                let _ = producer.try_push(0.25);
            });
            self.resource_alive.store(true, Ordering::Release);
            let output = f(CaptureStreamMeta {
                accepting: shared_open_gate(),
                callbacks_in_flight: Arc::new(AtomicUsize::new(0)),
                consumer,
                device_name: String::from("Continuous Fake"),
                native_rate: TARGET_RATE,
                overflow: Arc::new(AtomicBool::new(false)),
                stream_error: Arc::new(AtomicBool::new(false)),
            });
            self.runtime.clear_feed();
            self.resource_alive.store(false, Ordering::Release);
            Ok(output)
        }

        fn list_devices(
            &self,
        ) -> Result<Vec<InputDeviceDescriptor>, String> {
            Ok(vec![])
        }
    }

    struct ChangingDefaultBackend {
        opens: AtomicUsize,
    }

    impl StreamBackend for ChangingDefaultBackend {
        fn with_stream<F, R>(
            &self,
            selection: &DeviceSelection,
            f: F,
        ) -> Result<R, String>
        where
            F: FnOnce(CaptureStreamMeta) -> R,
        {
            use ringbuf::traits::Split;

            assert!(matches!(selection, DeviceSelection::SystemDefault));
            let index = self.opens.fetch_add(1, Ordering::AcqRel);
            let ring = ringbuf::HeapRb::<f32>::new(RING_CAPACITY);
            let (_producer, consumer) = ring.split();
            Ok(f(CaptureStreamMeta {
                accepting: shared_open_gate(),
                callbacks_in_flight: Arc::new(AtomicUsize::new(0)),
                consumer,
                device_name: format!("Default {index}"),
                native_rate: TARGET_RATE,
                overflow: Arc::new(AtomicBool::new(false)),
                stream_error: Arc::new(AtomicBool::new(true)),
            }))
        }

        fn list_devices(
            &self,
        ) -> Result<Vec<InputDeviceDescriptor>, String> {
            Ok(vec![])
        }
    }

    struct ListingBackend {
        error: Option<String>,
        listed: Vec<InputDeviceDescriptor>,
    }

    impl StreamBackend for ListingBackend {
        fn with_stream<F, R>(
            &self,
            _selection: &DeviceSelection,
            _f: F,
        ) -> Result<R, String>
        where
            F: FnOnce(CaptureStreamMeta) -> R,
        {
            panic!("device listing must not open an input stream")
        }

        fn list_devices(
            &self,
        ) -> Result<Vec<InputDeviceDescriptor>, String> {
            if let Some(error) = &self.error {
                Err(error.clone())
            } else {
                Ok(self.listed.clone())
            }
        }
    }

    fn mk<P: PermissionBackend, S: StreamBackend>(
        p: P,
        s: S,
    ) -> Coordinator<P, S> {
        Coordinator::with_backends(p, s)
    }

    fn mk_timed<P: PermissionBackend, S: StreamBackend>(
        permission: P,
        stream_backend: S,
    ) -> Coordinator<P, S> {
        Coordinator::with_loop_runtime(
            permission,
            stream_backend,
            VirtualRuntime::default(),
            short_test_limits(),
        )
    }

    fn mk_emit() -> (
        impl Fn(SessionEvent) + Send + 'static + Clone,
        Arc<Mutex<Vec<String>>>,
    ) {
        let log: Arc<Mutex<Vec<String>>> =
            Arc::new(Mutex::new(Vec::new()));
        let log2 = Arc::clone(&log);
        let emit = move |e: SessionEvent| {
            log2.lock().unwrap().push(event_tag(&e));
        };
        (emit, log)
    }

    fn event_tag(e: &SessionEvent) -> String {
        match e {
            SessionEvent::PermissionStatus { status, .. } => {
                format!("perm:{status:?}")
            }
            SessionEvent::CaptureStarted { .. } => {
                String::from("started")
            }
            SessionEvent::ActivityDetected { .. } => {
                String::from("activity")
            }
            SessionEvent::TestComplete { .. } => {
                String::from("test-complete")
            }
            SessionEvent::CaptureStopped { .. } => {
                String::from("stopped")
            }
            SessionEvent::CaptureCancelled { .. } => {
                String::from("cancelled")
            }
            SessionEvent::CaptureError { category, .. } => {
                format!("error:{category}")
            }
        }
    }

    fn wait_for(
        log: &Arc<Mutex<Vec<String>>>,
        tag: &str,
        timeout: Duration,
    ) -> bool {
        let start = Instant::now();
        loop {
            if log.lock().unwrap().iter().any(|t| t == tag) {
                return true;
            }
            if start.elapsed() > timeout {
                return false;
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn idle_wait(c: &impl IsActive, timeout: Duration) {
        let start = Instant::now();
        while c.is_active() && start.elapsed() < timeout {
            thread::sleep(Duration::from_millis(5));
        }
    }

    trait IsActive {
        fn is_active(&self) -> bool;
    }
    impl<P: PermissionBackend, S: StreamBackend> IsActive
        for Coordinator<P, S>
    {
        fn is_active(&self) -> bool {
            Coordinator::is_active(self)
        }
    }

    fn authorized_backend(samples: Vec<f32>) -> (
        FakePermission,
        FakeStreamBackend,
    ) {
        (
            FakePermission(MicPermission::Authorized),
            FakeStreamBackend::new(samples),
        )
    }

    // Invariants

    #[test]
    fn starts_idle() {
        let (p, s) = authorized_backend(vec![]);
        assert!(!mk(p, s).is_active());
    }

    #[test]
    fn rejects_invalid_request_ids() {
        let (p, s) = authorized_backend(vec![]);
        let c = mk(p, s);
        let (emit, _) = mk_emit();
        assert_eq!(
            c.start_session(
                String::from("invalid request"),
                DeviceSelection::SystemDefault,
                true,
                emit,
            ),
            Err(String::from("invalid-request-id")),
        );
        assert!(!c.cancel_request(""));
    }

    #[test]
    fn busy_rejects_second_start() {
        let (p, s) = authorized_backend(vec![]);
        let c = mk(p, s);
        let (e1, _) = mk_emit();
        let (e2, _) = mk_emit();
        let status = c
            .start_session(
                String::from("request-1"),
                DeviceSelection::SystemDefault,
                true,
                e1,
            )
            .unwrap();
        assert_eq!(
            c.start_session(
                String::from("request-2"),
                DeviceSelection::SystemDefault,
                true,
                e2,
            ),
            Err(String::from("busy"))
        );
        c.cancel_request(&status.request_id);
        idle_wait(&c, Duration::from_secs(3));
    }

    #[test]
    fn generation_and_cancel_reserved_before_spawn() {
        // After start_session returns Ok(gen), cancel(gen) must return
        // true — the flag is installed before the worker thread runs.
        let (p, s) = authorized_backend(vec![]);
        let c = mk(p, s);
        let (emit, _) = mk_emit();
        let status = c
            .start_session(
                String::from("request"),
                DeviceSelection::SystemDefault,
                true,
                emit,
            )
            .unwrap();
        // Immediately cancel; the flag must already be registered.
        assert!(
            c.cancel_request(&status.request_id),
            "cancel flag must be registered before thread",
        );
        idle_wait(&c, Duration::from_secs(3));
    }

    #[test]
    fn terminal_callback_can_start_without_old_guard_clearing_new_run() {
        let resource_alive = Arc::new(AtomicBool::new(false));
        let coordinator = Arc::new(Coordinator::with_backends(
            FakePermission(MicPermission::Authorized),
            RestartStreamBackend {
                opens: AtomicUsize::new(0),
                resource_alive: Arc::clone(&resource_alive),
            },
        ));
        let callback_coordinator = Arc::clone(&coordinator);
        let callback_resource = Arc::clone(&resource_alive);
        let (restart_tx, restart_rx) = mpsc::channel();
        let emit = move |event: SessionEvent| {
            if matches!(event, SessionEvent::CaptureError { .. }) {
                assert!(
                    !callback_resource.load(Ordering::Acquire),
                    "stream resource must be released before terminal event",
                );
                let restarted = callback_coordinator.start_session(
                    String::from("first-request"),
                    DeviceSelection::SystemDefault,
                    true,
                    |_| {},
                );
                restart_tx.send(restarted).unwrap();
            }
        };

        let first = coordinator
            .start_session(
                String::from("first-request"),
                DeviceSelection::SystemDefault,
                true,
                emit,
            )
            .unwrap();
        let second = restart_rx
            .recv_timeout(Duration::from_secs(3))
            .expect("terminal callback should start the next session")
            .expect("reservation must be released before terminal callback");
        assert!(second.generation > first.generation);

        thread::sleep(Duration::from_millis(20));
        assert_eq!(
            coordinator.status(),
            Some(second.clone()),
            "old guard must preserve a new generation with the same ID",
        );
        assert!(coordinator.cancel_request(&second.request_id));
        idle_wait(coordinator.as_ref(), Duration::from_secs(3));
    }

    #[test]
    fn cancel_before_start_targets_only_same_request() {
        let (p, s) = authorized_backend(vec![]);
        let c = mk(p, s);
        assert!(c.cancel_request("cancelled-request"));

        let (emit, log) = mk_emit();
        let status = c
            .start_session(
                String::from("cancelled-request"),
                DeviceSelection::SystemDefault,
                true,
                emit,
            )
            .unwrap();
        assert_eq!(status.request_id, "cancelled-request");
        assert!(wait_for(&log, "cancelled", Duration::from_secs(3)));
        idle_wait(&c, Duration::from_secs(3));
        let cancelled_events = log.lock().unwrap().clone();
        let cancelled_terminals = cancelled_events
            .iter()
            .filter(|event| {
                event.starts_with("error:")
                    || event.as_str() == "cancelled"
                    || event.as_str() == "stopped"
                    || event.as_str() == "test-complete"
            })
            .count();
        assert_eq!(
            cancelled_terminals,
            1,
            "pre-start tombstone must emit exactly one terminal",
        );

        let (next_emit, next_log) = mk_emit();
        let next = c
            .start_session(
                String::from("next-request"),
                DeviceSelection::SystemDefault,
                true,
                next_emit,
            )
            .unwrap();
        assert_eq!(next.request_id, "next-request");
        assert!(wait_for(
            &next_log,
            "started",
            Duration::from_secs(3),
        ));
        assert_eq!(
            c.status(),
            Some(next.clone()),
            "tombstone for another ID must not cancel this request",
        );
        let unrelated_terminals = next_log
            .lock()
            .unwrap()
            .iter()
            .filter(|event| {
                event.starts_with("error:")
                    || event.as_str() == "cancelled"
                    || event.as_str() == "stopped"
                    || event.as_str() == "test-complete"
            })
            .count();
        assert_eq!(
            unrelated_terminals,
            0,
            "cancelled request ID must emit no terminal for unrelated IDs",
        );
        assert!(c.cancel_request(&next.request_id));
        idle_wait(&c, Duration::from_secs(3));
    }

    #[test]
    fn status_identifies_active_request_generation_and_mode() {
        let (p, s) = authorized_backend(vec![]);
        let c = mk(p, s);
        let (emit, _) = mk_emit();
        let started = c
            .start_session(
                String::from("owned-request"),
                DeviceSelection::SystemDefault,
                true,
                emit,
            )
            .unwrap();
        assert_eq!(c.status(), Some(started.clone()));
        assert_eq!(started.mode, CaptureMode::Test);
        c.cancel_request(&started.request_id);
    }

    // Permission states

    #[test]
    fn authorized_proceeds_to_started() {
        let (p, s) = authorized_backend(vec![0.5]);
        let c = mk(p, s);
        let (emit, log) = mk_emit();
        c.start_session(
            String::from("request"),
            DeviceSelection::SystemDefault,
            true,
            emit,
        ).unwrap();
        assert!(wait_for(&log, "started", Duration::from_secs(3)));
    }

    #[test]
    fn denied_emits_permission_error_not_started() {
        let c = mk(
            FakePermission(MicPermission::Denied),
            FakeStreamBackend::new(vec![]),
        );
        let (emit, log) = mk_emit();
        c.start_session(
            String::from("request"),
            DeviceSelection::SystemDefault,
            false,
            emit,
        ).unwrap();
        assert!(wait_for(
            &log,
            "error:permission-denied",
            Duration::from_secs(3),
        ));
        assert!(!log.lock().unwrap().contains(&String::from("started")));
    }

    #[test]
    fn restricted_emits_permission_error_with_status() {
        let c = mk(
            FakePermission(MicPermission::Restricted),
            FakeStreamBackend::new(vec![]),
        );
        let (emit, log) = mk_emit();
        c.start_session(
            String::from("request"),
            DeviceSelection::SystemDefault,
            false,
            emit,
        ).unwrap();
        assert!(wait_for(
            &log,
            "error:permission-denied",
            Duration::from_secs(3),
        ));
        // PermissionStatus::Restricted must appear in the event log.
        assert!(
            log.lock().unwrap().iter().any(|e| e.contains("Restricted")),
            "Restricted permission status must be emitted"
        );
    }

    // Cancel at every phase

    #[test]
    fn cancel_before_open_emits_exactly_one_terminal() {
        let (p, s) = authorized_backend(vec![]);
        let c = mk(p, s);
        let (emit, log) = mk_emit();
        let status = c
            .start_session(
                String::from("request"),
                DeviceSelection::SystemDefault,
                true,
                emit,
            )
            .unwrap();
        c.cancel_request(&status.request_id);
        idle_wait(&c, Duration::from_secs(3));
        let events = log.lock().unwrap().clone();
        let terminals: Vec<_> = events.iter().filter(|e| {
            e.starts_with("error:")
                || *e == "cancelled"
                || *e == "stopped"
                || *e == "test-complete"
        }).collect();
        assert_eq!(
            terminals.len(),
            1,
            "exactly one terminal; got: {events:?}"
        );
    }

    #[test]
    fn session_status_clears_after_terminal() {
        let c = mk(
            FakePermission(MicPermission::Denied),
            FakeStreamBackend::new(vec![]),
        );
        let (emit, log) = mk_emit();
        c.start_session(
            String::from("request"),
            DeviceSelection::SystemDefault,
            false,
            emit,
        )
            .unwrap();
        wait_for(&log, "error:permission-denied", Duration::from_secs(3));
        idle_wait(&c, Duration::from_secs(3));
        assert!(c.status().is_none());
    }

    #[test]
    fn unknown_request_cancel_does_not_activate_session() {
        let (p, s) = authorized_backend(vec![]);
        let coordinator = mk(p, s);
        assert!(coordinator.cancel_request("unknown-request"));
        assert!(coordinator.status().is_none());
    }

    // Stream error

    #[test]
    fn open_error_emits_capture_unavailable() {
        let c = mk(
            FakePermission(MicPermission::Authorized),
            FakeStreamBackend {
                open_error: Some(String::from(
                    "capture-unavailable: no device",
                )),
                ..FakeStreamBackend::new(vec![])
            },
        );
        let (emit, log) = mk_emit();
        c.start_session(
            String::from("request"),
            DeviceSelection::SystemDefault,
            false,
            emit,
        ).unwrap();
        assert!(wait_for(
            &log,
            "error:capture-unavailable",
            Duration::from_secs(3),
        ));
    }

    #[test]
    fn final_identity_failure_discards_pcm_and_emits_one_error() {
        let resource_alive = Arc::new(AtomicBool::new(false));
        let coordinator = mk_timed(
            FakePermission(MicPermission::Authorized),
            PostCaptureIdentityFailureBackend {
                resource_alive: Arc::clone(&resource_alive),
            },
        );
        let events = Arc::new(Mutex::new(Vec::new()));
        let emitted = Arc::clone(&events);
        let resource_at_terminal = Arc::clone(&resource_alive);
        let status = coordinator
            .start_session(
                String::from("identity-request"),
                DeviceSelection::SystemDefault,
                true,
                move |event| {
                    if matches!(event, SessionEvent::CaptureError { .. }) {
                        assert!(!resource_at_terminal.load(Ordering::Acquire));
                    }
                    emitted.lock().unwrap().push(event);
                },
            )
            .unwrap();
        idle_wait(&coordinator, Duration::from_secs(3));

        let events = events.lock().unwrap();
        let terminals: Vec<_> = events
            .iter()
            .filter(|event| {
                matches!(
                    event,
                    SessionEvent::TestComplete { .. }
                        | SessionEvent::CaptureStopped { .. }
                        | SessionEvent::CaptureCancelled { .. }
                        | SessionEvent::CaptureError { .. }
                )
            })
            .collect();
        assert_eq!(terminals.len(), 1, "events: {events:?}");
        assert!(matches!(
            terminals[0],
            SessionEvent::CaptureError {
                category,
                generation,
                request_id,
                ..
            } if category == "capture-unavailable"
                && *generation == status.generation
                && request_id == &status.request_id
        ));
        assert!(!events
            .iter()
            .any(|event| matches!(event, SessionEvent::TestComplete { .. })));
    }

    #[test]
    fn system_default_is_resolved_again_for_each_start() {
        let coordinator = mk(
            FakePermission(MicPermission::Authorized),
            ChangingDefaultBackend {
                opens: AtomicUsize::new(0),
            },
        );
        let labels = Arc::new(Mutex::new(Vec::new()));

        for request_id in ["default-first", "default-second"] {
            let event_labels = Arc::clone(&labels);
            coordinator
                .start_session(
                    String::from(request_id),
                    DeviceSelection::SystemDefault,
                    false,
                    move |event| {
                        if let SessionEvent::CaptureStarted {
                            device_name,
                            ..
                        } = event
                        {
                            event_labels.lock().unwrap().push(device_name);
                        }
                    },
                )
                .unwrap();
            idle_wait(&coordinator, Duration::from_secs(3));
        }

        assert_eq!(
            labels.lock().unwrap().as_slice(),
            &[String::from("Default 0"), String::from("Default 1")],
        );
    }

    #[test]
    fn listing_devices_never_queries_or_requests_permission() {
        let queries = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(AtomicUsize::new(0));
        let coordinator = mk(
            CountingPermission {
                queries: Arc::clone(&queries),
                requests: Arc::clone(&requests),
            },
            ListingBackend {
                error: None,
                listed: vec![InputDeviceDescriptor {
                    available: true,
                    id: String::from("input-1"),
                    label: String::from("Desk microphone"),
                }],
            },
        );

        let listed = coordinator.list_devices().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(queries.load(Ordering::Acquire), 0);
        assert_eq!(requests.load(Ordering::Acquire), 0);
    }

    #[test]
    fn device_list_error_is_returned_without_opening_capture() {
        let coordinator = mk(
            FakePermission(MicPermission::Authorized),
            ListingBackend {
                error: Some(String::from(
                    "capture-unavailable: enumeration failed",
                )),
                listed: vec![],
            },
        );

        assert_eq!(
            coordinator.list_devices().unwrap_err(),
            "capture-unavailable: enumeration failed",
        );
    }

    #[test]
    fn device_stream_error_flag_emits_capture_unavailable() {
        // Stream error (device disconnect) must map to capture-unavailable,
        // NOT input-limit-exceeded.
        let c = mk(
            FakePermission(MicPermission::Authorized),
            FakeStreamBackend {
                simulate_stream_error: true,
                ..FakeStreamBackend::new(vec![])
            },
        );
        let (emit, log) = mk_emit();
        c.start_session(
            String::from("request"),
            DeviceSelection::SystemDefault,
            false,
            emit,
        ).unwrap();
        assert!(
            wait_for(
                &log,
                "error:capture-unavailable",
                Duration::from_secs(3),
            ),
            "stream error must be capture-unavailable"
        );
        assert!(
            !log.lock()
                .unwrap()
                .contains(&String::from("error:input-limit-exceeded")),
            "stream error must NOT be input-limit-exceeded"
        );
    }

    // Test mode

    #[test]
    fn production_test_mode_completes_at_ten_seconds() {
        let resource_alive = Arc::new(AtomicBool::new(false));
        let runtime = ProductionVirtualRuntime::default();
        let coordinator = Coordinator::with_loop_runtime(
            FakePermission(MicPermission::Authorized),
            ContinuousStreamBackend {
                resource_alive: Arc::clone(&resource_alive),
                runtime: runtime.clone(),
            },
            runtime.clone(),
            CaptureLimits::production(),
        );
        let terminals = Arc::new(Mutex::new(Vec::new()));
        let terminal_log = Arc::clone(&terminals);
        let event_runtime = runtime.clone();
        let emit = move |event: SessionEvent| {
            if let SessionEvent::TestComplete {
                generation,
                request_id,
                ..
            } = event
            {
                terminal_log.lock().unwrap().push((
                    generation,
                    request_id,
                    event_runtime.elapsed(),
                ));
            }
        };

        let status = coordinator
            .start_session(
                String::from("production-test"),
                DeviceSelection::SystemDefault,
                true,
                emit,
            )
            .unwrap();
        idle_wait(&coordinator, Duration::from_secs(3));

        assert_eq!(
            terminals.lock().unwrap().as_slice(),
            &[(
                status.generation,
                String::from("production-test"),
                Duration::from_secs(10),
            )],
        );
        assert_eq!(runtime.elapsed(), Duration::from_secs(10));
        assert!(!resource_alive.load(Ordering::Acquire));
        assert!(coordinator.status().is_none());
    }

    #[test]
    fn production_full_mode_is_active_at_ten_and_stops_at_one_twenty() {
        let resource_alive = Arc::new(AtomicBool::new(false));
        let runtime = ProductionVirtualRuntime::default();
        let coordinator = Arc::new(Coordinator::with_loop_runtime(
            FakePermission(MicPermission::Authorized),
            ContinuousStreamBackend {
                resource_alive: Arc::clone(&resource_alive),
                runtime: runtime.clone(),
            },
            runtime.clone(),
            CaptureLimits::production(),
        ));
        let status_at_ten = Arc::new(Mutex::new(None));
        let observed_status = Arc::clone(&status_at_ten);
        let ten_second_coordinator = Arc::clone(&coordinator);
        let terminal_count = Arc::new(AtomicUsize::new(0));
        let count_at_ten = Arc::new(AtomicUsize::new(usize::MAX));
        let observed_count = Arc::clone(&count_at_ten);
        let event_count = Arc::clone(&terminal_count);
        runtime.observe_ten_seconds(move || {
            *observed_status.lock().unwrap() =
                ten_second_coordinator.status();
            observed_count.store(
                event_count.load(Ordering::Acquire),
                Ordering::Release,
            );
        });

        let terminals = Arc::new(Mutex::new(Vec::new()));
        let terminal_log = Arc::clone(&terminals);
        let event_runtime = runtime.clone();
        let event_count = Arc::clone(&terminal_count);
        let emit = move |event: SessionEvent| {
            if let SessionEvent::CaptureStopped {
                generation,
                request_id,
            } = event
            {
                event_count.fetch_add(1, Ordering::AcqRel);
                terminal_log.lock().unwrap().push((
                    generation,
                    request_id,
                    event_runtime.elapsed(),
                ));
            }
        };

        let status = coordinator
            .start_session(
                String::from("production-full"),
                DeviceSelection::SystemDefault,
                false,
                emit,
            )
            .unwrap();
        idle_wait(coordinator.as_ref(), Duration::from_secs(3));

        assert_eq!(status_at_ten.lock().unwrap().as_ref(), Some(&status));
        assert_eq!(count_at_ten.load(Ordering::Acquire), 0);
        assert_eq!(
            terminals.lock().unwrap().as_slice(),
            &[(
                status.generation,
                String::from("production-full"),
                Duration::from_secs(120),
            )],
        );
        assert_eq!(terminal_count.load(Ordering::Acquire), 1);
        assert_eq!(runtime.elapsed(), Duration::from_secs(120));
        assert!(!resource_alive.load(Ordering::Acquire));
        assert!(coordinator.status().is_none());
    }

    #[test]
    fn test_mode_with_activity_must_emit_test_complete() {
        let c = mk_timed(
            FakePermission(MicPermission::Authorized),
            FakeStreamBackend {
                samples: vec![0.5f32; 160],
                ..FakeStreamBackend::new(vec![])
            },
        );
        let (emit, log) = mk_emit();
        c.start_session(
            String::from("request"),
            DeviceSelection::SystemDefault,
            true,
            emit,
        ).unwrap();
        // Must see test-complete; errors or stopped are failures.
        assert!(
            wait_for(&log, "test-complete", Duration::from_secs(5)),
            "expected test-complete; got: {:?}",
            log.lock().unwrap()
        );
        assert!(
            log.lock().unwrap().contains(&String::from("activity")),
            "0.5 samples must trigger activity"
        );
        // Exactly one terminal.
        let events = log.lock().unwrap().clone();
        let terminals: Vec<_> = events.iter().filter(|e| {
            e.starts_with("error:")
                || *e == "cancelled"
                || *e == "stopped"
                || *e == "test-complete"
        }).collect();
        assert_eq!(terminals.len(), 1, "exactly one terminal: {events:?}");
    }

    #[test]
    fn test_mode_silence_no_activity_event() {
        let c = mk_timed(
            FakePermission(MicPermission::Authorized),
            FakeStreamBackend {
                samples: vec![0.0f32; 160],
                ..FakeStreamBackend::new(vec![])
            },
        );
        let (emit, log) = mk_emit();
        c.start_session(
            String::from("request"),
            DeviceSelection::SystemDefault,
            true,
            emit,
        ).unwrap();
        assert!(wait_for(&log, "test-complete", Duration::from_secs(5)));
        assert!(
            !log.lock().unwrap().contains(&String::from("activity")),
            "silence must not emit activity"
        );
    }

    #[test]
    fn test_auto_stop_normalizes_and_reports_all_queued_audio() {
        let native_rate = 44_100;
        let input_frames = 2_205;
        let resource_alive = Arc::new(AtomicBool::new(false));
        let c = mk_timed(
            FakePermission(MicPermission::Authorized),
            FakeStreamBackend {
                native_rate,
                resource_alive: Some(Arc::clone(&resource_alive)),
                samples: vec![0.5; input_frames],
                ..FakeStreamBackend::new(vec![])
            },
        );
        let events = Arc::new(Mutex::new(Vec::new()));
        let events_for_emit = Arc::clone(&events);
        let resource_for_emit = Arc::clone(&resource_alive);
        let status = c
            .start_session(
                String::from("normalized-test"),
                DeviceSelection::SystemDefault,
                true,
                move |event| {
                    if matches!(event, SessionEvent::TestComplete { .. }) {
                        assert!(
                            !resource_for_emit.load(Ordering::Acquire),
                            "stream must be released before terminal",
                        );
                    }
                    events_for_emit.lock().unwrap().push(event);
                },
            )
            .unwrap();
        idle_wait(&c, Duration::from_secs(3));

        let events = events.lock().unwrap();
        let terminals: Vec<_> = events
            .iter()
            .filter(|event| {
                matches!(
                    event,
                    SessionEvent::TestComplete { .. }
                        | SessionEvent::CaptureStopped { .. }
                        | SessionEvent::CaptureCancelled { .. }
                        | SessionEvent::CaptureError { .. }
                )
            })
            .collect();
        assert_eq!(terminals.len(), 1, "auto-stop must emit one terminal");
        let metadata = terminals
            .iter()
            .find_map(|event| match event {
                SessionEvent::TestComplete {
                    generation,
                    metadata,
                    request_id,
                } => {
                    assert_eq!(*generation, status.generation);
                    assert_eq!(request_id, &status.request_id);
                    Some(metadata)
                }
                _ => None,
            })
            .expect("test timer must end with TestComplete");
        assert_eq!(metadata.frame_count, 800);
        assert!((metadata.duration_secs - 0.05).abs() < 1e-9);
        assert!(c.status().is_none());
    }

    // Overflow flags

    #[test]
    fn ring_overflow_emits_input_limit_exceeded() {
        let c = mk(
            FakePermission(MicPermission::Authorized),
            FakeStreamBackend {
                simulate_overflow: true,
                ..FakeStreamBackend::new(vec![])
            },
        );
        let (emit, log) = mk_emit();
        c.start_session(
            String::from("request"),
            DeviceSelection::SystemDefault,
            false,
            emit,
        ).unwrap();
        assert!(
            wait_for(
                &log,
                "error:input-limit-exceeded",
                Duration::from_secs(5),
            ),
            "ring overflow must be input-limit-exceeded"
        );
    }

    // Generation counter

    #[test]
    fn generations_increment_per_session() {
        let c = mk(
            FakePermission(MicPermission::Denied),
            FakeStreamBackend::new(vec![]),
        );
        assert_eq!(c.current_generation(), 0);
        let (e1, l1) = mk_emit();
        let first = c
            .start_session(
                String::from("request-1"),
                DeviceSelection::SystemDefault,
                false,
                e1,
            )
            .unwrap();
        assert_eq!(first.generation, 1);
        wait_for(&l1, "error:permission-denied", Duration::from_secs(3));
        idle_wait(&c, Duration::from_secs(3));
        let (e2, _) = mk_emit();
        let second = c
            .start_session(
                String::from("request-2"),
                DeviceSelection::SystemDefault,
                false,
                e2,
            )
            .unwrap();
        assert_eq!(second.generation, 2);
        c.cancel_request(&second.request_id);
    }

    #[test]
    fn all_session_events_carry_request_and_generation() {
        // Verify that the PermissionStatus event from a session carries the
        // correct generation by checking the log tag includes generation info.
        // (Full generation field verification requires matching event structs.)
        let c = mk_timed(
            FakePermission(MicPermission::Authorized),
            FakeStreamBackend {
                samples: vec![0.5f32; 80],
                ..FakeStreamBackend::new(vec![])
            },
        );
        let events: Arc<Mutex<Vec<SessionEvent>>> =
            Arc::new(Mutex::new(Vec::new()));
        let events2 = Arc::clone(&events);
        let status = c
            .start_session(
                String::from("request"),
                DeviceSelection::SystemDefault,
                true,
                move |e: SessionEvent| {
                    events2.lock().unwrap().push(e.clone());
                },
            )
            .unwrap();
        // Wait for TestComplete.
        let start = Instant::now();
        loop {
            let has_tc = events.lock().unwrap().iter().any(|e| {
                matches!(e, SessionEvent::TestComplete { .. })
            });
            if has_tc || start.elapsed() > Duration::from_secs(5) {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let evs = events.lock().unwrap().clone();
        // Every session event must carry the expected correlation pair.
        for ev in &evs {
            let (event_generation, event_request_id) = match ev {
                SessionEvent::PermissionStatus {
                    generation,
                    request_id,
                    ..
                }
                | SessionEvent::CaptureStarted {
                    generation,
                    request_id,
                    ..
                }
                | SessionEvent::ActivityDetected {
                    generation,
                    request_id,
                }
                | SessionEvent::TestComplete {
                    generation,
                    request_id,
                    ..
                }
                | SessionEvent::CaptureStopped {
                    generation,
                    request_id,
                }
                | SessionEvent::CaptureCancelled {
                    generation,
                    request_id,
                }
                | SessionEvent::CaptureError {
                    generation,
                    request_id,
                    ..
                } => (*generation, request_id),
            };
            assert_eq!(
                event_generation, status.generation,
                "event {ev:?} has wrong generation"
            );
            assert_eq!(event_request_id, "request");
        }
    }

    // capture_loop unit

    #[test]
    fn capture_loop_accumulates_then_cancel_terminates() {
        use ringbuf::traits::{Producer, Split};
        let rb = ringbuf::HeapRb::<f32>::new(RING_CAPACITY);
        let (mut producer, mut consumer) = rb.split();
        assert_eq!(producer.push_slice(&[0.5; 480]), 480);
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_for_thread = Arc::clone(&cancel);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(80));
            cancel_for_thread.store(true, Ordering::Release);
        });
        let accepting = open_gate();
        let callbacks_in_flight = AtomicUsize::new(0);
        let overflow = AtomicBool::new(false);
        let stream_error = AtomicBool::new(false);
        let mut downmixer = Downmixer::new(TARGET_RATE).unwrap();
        let mut buffer = CaptureBuffer::new();
        let runtime = SystemLoopRuntime::new();
        let start = runtime.now();
        let mut last_sample = start;
        let mut activity = false;

        let terminal = capture_loop(
            &mut consumer,
            &accepting,
            &callbacks_in_flight,
            &overflow,
            &stream_error,
            &cancel,
            &mut downmixer,
            &mut buffer,
            Duration::from_secs(FULL_SAFETY_SECS),
            CaptureLimits::production(),
            &mut last_sample,
            &mut activity,
            start,
            1,
            "request",
            &|_| {},
            &runtime,
        );

        assert!(matches!(terminal, LoopTerminal::Cancelled));
        assert!(activity);
        assert_eq!(buffer.len(), 480);
    }

    #[test]
    fn capture_loop_overflow_returns_input_limit_exceeded() {
        use ringbuf::traits::Split;
        let mut consumer = ringbuf::HeapRb::<f32>::new(8).split().1;
        let overflow = AtomicBool::new(true);
        let stream_error = AtomicBool::new(false);
        let terminal = run_immediate_loop(
            &mut consumer,
            &overflow,
            &stream_error,
        );
        assert!(matches!(terminal, LoopTerminal::Error(ref category, _)
            if category == "input-limit-exceeded"));
    }

    #[test]
    fn capture_loop_stream_error_returns_capture_unavailable() {
        use ringbuf::traits::Split;
        let mut consumer = ringbuf::HeapRb::<f32>::new(8).split().1;
        let overflow = AtomicBool::new(false);
        let stream_error = AtomicBool::new(true);
        let terminal = run_immediate_loop(
            &mut consumer,
            &overflow,
            &stream_error,
        );
        assert!(matches!(terminal, LoopTerminal::Error(ref category, _)
            if category == "capture-unavailable"));
    }

    #[test]
    fn capture_loop_identity_invalidation_returns_capture_unavailable() {
        use ringbuf::traits::Split;
        let mut consumer = ringbuf::HeapRb::<f32>::new(8).split().1;
        let accepting = open_gate();
        accepting.invalidate();
        let overflow = AtomicBool::new(false);
        let stream_error = AtomicBool::new(false);
        let terminal = run_immediate_loop_with_gate(
            &mut consumer,
            &accepting,
            &overflow,
            &stream_error,
        );
        assert!(matches!(terminal, LoopTerminal::Error(ref category, _)
            if category == "capture-unavailable"));
    }

    #[test]
    fn capture_loop_deadline_drains_queue_and_flushes_once() {
        use ringbuf::traits::{Producer, Split};
        let rb = ringbuf::HeapRb::<f32>::new(512);
        let (mut producer, mut consumer) = rb.split();
        assert_eq!(producer.push_slice(&[0.5; 480]), 480);
        let accepting = open_gate();
        let callbacks_in_flight = AtomicUsize::new(0);
        let overflow = AtomicBool::new(false);
        let stream_error = AtomicBool::new(false);
        let cancel = AtomicBool::new(false);
        let mut downmixer = Downmixer::new(TARGET_RATE).unwrap();
        let mut buffer = CaptureBuffer::new();
        let runtime = VirtualRuntime {
            elapsed_millis: AtomicU64::new(30),
        };
        let start = Duration::ZERO;
        let mut last_sample = start;
        let mut activity = false;

        let terminal = capture_loop(
            &mut consumer,
            &accepting,
            &callbacks_in_flight,
            &overflow,
            &stream_error,
            &cancel,
            &mut downmixer,
            &mut buffer,
            Duration::from_millis(30),
            short_test_limits(),
            &mut last_sample,
            &mut activity,
            start,
            1,
            "request",
            &|_| {},
            &runtime,
        );

        assert!(matches!(terminal, LoopTerminal::Clean));
        assert_eq!(buffer.len(), 480, "deadline must drain queued frames");
        assert_eq!(
            downmixer.flush_calls(),
            1,
            "deadline must flush exactly once",
        );
        assert!(!accepting.is_open());
    }

    #[test]
    fn capture_loop_waits_for_accepted_callback_before_draining() {
        use ringbuf::traits::{Producer, Split};
        let rb = ringbuf::HeapRb::<f32>::new(8);
        let (mut producer, mut consumer) = rb.split();
        assert_eq!(producer.push_slice(&[0.5]), 1);
        let accepting = open_gate();
        let callbacks_in_flight = Arc::new(AtomicUsize::new(1));
        let overflow = AtomicBool::new(false);
        let stream_error = AtomicBool::new(false);
        let cancel = AtomicBool::new(false);
        let mut downmixer = Downmixer::new(TARGET_RATE).unwrap();
        let mut buffer = CaptureBuffer::new();
        let runtime = DrainingRuntime {
            callbacks_in_flight: Arc::clone(&callbacks_in_flight),
            waits: AtomicUsize::new(0),
        };
        let mut last_sample = Duration::ZERO;
        let mut activity = false;

        let terminal = capture_loop(
            &mut consumer,
            &accepting,
            callbacks_in_flight.as_ref(),
            &overflow,
            &stream_error,
            &cancel,
            &mut downmixer,
            &mut buffer,
            Duration::from_millis(30),
            short_test_limits(),
            &mut last_sample,
            &mut activity,
            Duration::ZERO,
            1,
            "request",
            &|_| {},
            &runtime,
        );

        assert!(matches!(terminal, LoopTerminal::Clean));
        assert_eq!(runtime.waits.load(Ordering::Acquire), 1);
        assert_eq!(buffer.len(), 1);
        assert!(!accepting.is_open());
    }

    #[test]
    fn capture_loop_reports_when_flush_exceeds_bounded_buffer() {
        use ringbuf::traits::{Producer, Split};
        let rb = ringbuf::HeapRb::<f32>::new(8);
        let (mut producer, mut consumer) = rb.split();
        assert_eq!(producer.push_slice(&[0.5; 3]), 3);
        let accepting = open_gate();
        let callbacks_in_flight = AtomicUsize::new(0);
        let overflow = AtomicBool::new(false);
        let stream_error = AtomicBool::new(false);
        let cancel = AtomicBool::new(false);
        let mut downmixer = Downmixer::new(48_000).unwrap();
        let mut buffer = CaptureBuffer::new();
        buffer.push(&vec![0.0; MAX_FRAMES]).unwrap();
        let runtime = VirtualRuntime {
            elapsed_millis: AtomicU64::new(30),
        };
        let start = Duration::ZERO;
        let mut last_sample = start;
        let mut activity = false;

        let terminal = capture_loop(
            &mut consumer,
            &accepting,
            &callbacks_in_flight,
            &overflow,
            &stream_error,
            &cancel,
            &mut downmixer,
            &mut buffer,
            Duration::from_millis(30),
            short_test_limits(),
            &mut last_sample,
            &mut activity,
            start,
            1,
            "request",
            &|_| {},
            &runtime,
        );

        assert!(matches!(terminal, LoopTerminal::Error(ref category, _)
            if category == "input-limit-exceeded"));
        assert_eq!(downmixer.flush_calls(), 1);
        assert_eq!(buffer.len(), MAX_FRAMES);
        assert!(!accepting.is_open());
    }

    fn run_immediate_loop(
        consumer: &mut ringbuf::HeapCons<f32>,
        overflow: &AtomicBool,
        stream_error: &AtomicBool,
    ) -> LoopTerminal {
        let accepting = open_gate();
        run_immediate_loop_with_gate(
            consumer,
            &accepting,
            overflow,
            stream_error,
        )
    }

    fn run_immediate_loop_with_gate(
        consumer: &mut ringbuf::HeapCons<f32>,
        accepting: &CaptureGate,
        overflow: &AtomicBool,
        stream_error: &AtomicBool,
    ) -> LoopTerminal {
        let callbacks_in_flight = AtomicUsize::new(0);
        let cancel = AtomicBool::new(false);
        let mut downmixer = Downmixer::new(TARGET_RATE).unwrap();
        let mut buffer = CaptureBuffer::new();
        let runtime = VirtualRuntime::default();
        let start = runtime.now();
        let mut last_sample = start;
        let mut activity = false;
        capture_loop(
            consumer,
            accepting,
            &callbacks_in_flight,
            overflow,
            stream_error,
            &cancel,
            &mut downmixer,
            &mut buffer,
            Duration::from_secs(FULL_SAFETY_SECS),
            CaptureLimits::production(),
            &mut last_sample,
            &mut activity,
            start,
            1,
            "request",
            &|_| {},
            &runtime,
        )
    }
}

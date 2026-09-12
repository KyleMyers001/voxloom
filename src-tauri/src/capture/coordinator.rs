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
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};

use ringbuf::traits::Consumer;

use crate::capture::{
    buffer::CaptureBuffer,
    consumer::{inspect, TestCaptureMetadata},
    permission::{self, MicPermission},
    resample::Downmixer,
    stream::{self, DeviceSelection, StreamMeta, RING_CAPACITY},
};

// Constants

const FULL_SAFETY_SECS: u64 = 120;
const TEST_SAFETY_SECS: u64 = 10;
const WATCHDOG_IDLE_SECS: u64 = 5;
const ACTIVITY_THRESHOLD: f32 = 0.001; // −60 dBFS

// Session events

/// Events emitted to the renderer. No PCM bytes included. Session and
/// permission events carry correlation fields; device lists are not sessions.
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
    DeviceList {
        devices: Vec<String>,
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
    pub device_name: String,
    pub native_rate: u32,
    pub consumer: ringbuf::HeapCons<f32>,
    /// Latched true on ring-buffer overflow → `input-limit-exceeded`.
    pub overflow: Arc<AtomicBool>,
    /// Latched true on device error → `capture-unavailable`.
    pub stream_error: Arc<AtomicBool>,
    /// Latched true by fake backend to signal clean end-of-stream in tests.
    pub clean_stop: Arc<AtomicBool>,
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
    fn list_devices(&self) -> Vec<String>;
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

pub struct CpalStreamBackend;

impl StreamBackend for CpalStreamBackend {
    fn with_stream<F, R>(
        &self,
        selection: &DeviceSelection,
        f: F,
    ) -> Result<R, String>
    where
        F: FnOnce(CaptureStreamMeta) -> R,
    {
        stream::with_stream(selection, |meta: StreamMeta| {
            let clean_stop = Arc::new(AtomicBool::new(false));
            f(CaptureStreamMeta {
                clean_stop,
                consumer: meta.consumer,
                device_name: meta.device_name,
                native_rate: meta.native_rate,
                overflow: meta.overflow,
                stream_error: meta.stream_error,
            })
        })
    }

    fn list_devices(&self) -> Vec<String> {
        stream::list_input_device_names()
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
    permission: Arc<P>,
    state: Arc<Mutex<CoordinatorState>>,
    stream_backend: Arc<S>,
}

/// Production type alias.
pub type CaptureCoordinator = Coordinator;

impl Coordinator {
    pub fn new() -> Self {
        Coordinator {
            generation: AtomicU64::new(0),
            permission: Arc::new(RealPermissionBackend),
            state: Arc::new(Mutex::new(CoordinatorState {
                cancelled_requests: VecDeque::new(),
                reservation: None,
            })),
            stream_backend: Arc::new(CpalStreamBackend),
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
            permission: Arc::new(permission),
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
        let stream_backend = Arc::clone(&self.stream_backend);
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
                permission,
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
    permission: Arc<P>,
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
                let bound = Duration::from_secs(
                    if test_mode {
                        TEST_SAFETY_SECS
                    } else {
                        FULL_SAFETY_SECS
                    },
                );
                let start = Instant::now();
                let mut last_sample = Instant::now();
                let mut activity_emitted = false;
                let mut consumer = meta.consumer;

                let term = capture_loop(
                    &mut consumer,
                    &meta.overflow,
                    &meta.stream_error,
                    &meta.clean_stop,
                    &cancel,
                    &mut downmixer,
                    &mut buffer,
                    bound,
                    &mut last_sample,
                    &mut activity_emitted,
                    start,
                    gen,
                    &request_id,
                    emit,
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
/// `clean_stop` is a test-only seam; real backends always leave it false.
#[allow(clippy::too_many_arguments)]
fn capture_loop<E: Fn(SessionEvent)>(
    consumer: &mut ringbuf::HeapCons<f32>,
    overflow: &AtomicBool,
    stream_error: &AtomicBool,
    clean_stop: &AtomicBool,
    cancel: &AtomicBool,
    downmixer: &mut Downmixer,
    buffer: &mut CaptureBuffer,
    bound: Duration,
    last_sample: &mut Instant,
    activity_emitted: &mut bool,
    start: Instant,
    gen: u64,
    request_id: &str,
    emit: &E,
) -> LoopTerminal {
    let mut drain_buf = vec![0.0f32; RING_CAPACITY];

    loop {
        if is_cancelled(cancel) {
            return LoopTerminal::Cancelled;
        }

        let n = consumer.pop_slice(&mut drain_buf);

        if n > 0 {
            *last_sample = Instant::now();
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

        // Test-only: clean end-of-stream signal from fake backend.
        if clean_stop.load(Ordering::Acquire) {
            if let Ok(tail) = downmixer.flush() {
                let _ = buffer.push(&tail);
            }
            return LoopTerminal::Clean;
        }

        if start.elapsed() >= bound {
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

        if start.elapsed() > Duration::from_secs(1)
            && last_sample.elapsed()
                > Duration::from_secs(WATCHDOG_IDLE_SECS)
        {
            return LoopTerminal::Error(
                String::from("capture-unavailable"),
                String::from("No audio received from device."),
            );
        }

        std::thread::sleep(Duration::from_millis(10));
    }
}

// Tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::AtomicUsize, Arc, Mutex};

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

    struct FakeStreamBackend {
        samples: Vec<f32>,
        open_error: Option<String>,
        /// Pre-latch ring overflow flag (→ input-limit-exceeded).
        simulate_overflow: bool,
        /// Pre-latch stream_error flag (→ capture-unavailable).
        simulate_stream_error: bool,
        /// Signal clean end-of-stream after samples are consumed.
        simulate_clean_stop: bool,
    }

    impl FakeStreamBackend {
        fn new(samples: Vec<f32>) -> Self {
            FakeStreamBackend {
                open_error: None,
                samples,
                simulate_clean_stop: false,
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
                clean_stop: Arc::new(AtomicBool::new(
                    self.simulate_clean_stop,
                )),
                consumer: cons,
                device_name: String::from("Fake"),
                native_rate: 16_000,
                overflow: Arc::new(AtomicBool::new(
                    self.simulate_overflow,
                )),
                stream_error: Arc::new(AtomicBool::new(
                    self.simulate_stream_error,
                )),
            };
            Ok(f(meta))
        }

        fn list_devices(&self) -> Vec<String> {
            vec![String::from("Fake")]
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

            let clean_stop = self.opens.fetch_add(1, Ordering::AcqRel) == 0;
            let rb = ringbuf::HeapRb::<f32>::new(RING_CAPACITY);
            let (_producer, consumer) = rb.split();
            self.resource_alive.store(true, Ordering::Release);
            let output = f(CaptureStreamMeta {
                clean_stop: Arc::new(AtomicBool::new(clean_stop)),
                consumer,
                device_name: String::from("Restart Fake"),
                native_rate: 16_000,
                overflow: Arc::new(AtomicBool::new(false)),
                stream_error: Arc::new(AtomicBool::new(false)),
            });
            self.resource_alive.store(false, Ordering::Release);
            Ok(output)
        }

        fn list_devices(&self) -> Vec<String> {
            vec![String::from("Restart Fake")]
        }
    }

    fn mk<P: PermissionBackend, S: StreamBackend>(
        p: P,
        s: S,
    ) -> Coordinator<P, S> {
        Coordinator::with_backends(p, s)
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
            SessionEvent::DeviceList { .. } => {
                String::from("device-list")
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
            if matches!(event, SessionEvent::TestComplete { .. }) {
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
    fn test_mode_with_activity_must_emit_test_complete() {
        // Use simulate_clean_stop: true so the loop terminates cleanly
        // (not via watchdog) and the coordinator emits TestComplete.
        let c = mk(
            FakePermission(MicPermission::Authorized),
            FakeStreamBackend {
                samples: vec![0.5f32; 160],
                simulate_clean_stop: true,
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
        let c = mk(
            FakePermission(MicPermission::Authorized),
            FakeStreamBackend {
                samples: vec![0.0f32; 160],
                simulate_clean_stop: true,
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
        let c = mk(
            FakePermission(MicPermission::Authorized),
            FakeStreamBackend {
                samples: vec![0.5f32; 80],
                simulate_clean_stop: true,
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
                SessionEvent::DeviceList { .. } => continue, // no gen
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
        let (mut prod, mut cons) = rb.split();
        for _ in 0..480 {
            let _ = prod.try_push(0.5f32);
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel2 = Arc::clone(&cancel);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(80));
            cancel2.store(true, Ordering::Release);
        });

        let overflow = AtomicBool::new(false);
        let stream_error = AtomicBool::new(false);
        let clean_stop = AtomicBool::new(false);
        let mut dm = Downmixer::new(16_000).unwrap();
        let mut buf = CaptureBuffer::new();
        let mut last = Instant::now();
        let mut act = false;
        let emit_noop = |_: SessionEvent| {};

        let term = capture_loop(
            &mut cons,
            &overflow,
            &stream_error,
            &clean_stop,
            &cancel,
            &mut dm,
            &mut buf,
            Duration::from_secs(120),
            &mut last,
            &mut act,
            Instant::now(),
            1,
            "request",
            &emit_noop,
        );

        assert!(
            matches!(term, LoopTerminal::Cancelled),
            "expected Cancelled"
        );
        assert!(act, "0.5 samples trigger activity");
        assert!(buf.len() > 0);
        drop(prod);
    }

    #[test]
    fn capture_loop_overflow_returns_input_limit_exceeded() {
        use ringbuf::traits::Split;
        let mut cons = ringbuf::HeapRb::<f32>::new(8).split().1;
        let overflow = AtomicBool::new(true);
        let stream_error = AtomicBool::new(false);
        let clean_stop = AtomicBool::new(false);
        let cancel = AtomicBool::new(false);
        let mut dm = Downmixer::new(16_000).unwrap();
        let mut buf = CaptureBuffer::new();
        let mut last = Instant::now();
        let mut act = false;
        let emit_noop = |_: SessionEvent| {};

        let term = capture_loop(
            &mut cons, &overflow, &stream_error, &clean_stop,
            &cancel, &mut dm, &mut buf,
            Duration::from_secs(120), &mut last, &mut act,
            Instant::now(), 1, "request", &emit_noop,
        );
        assert!(
            matches!(term, LoopTerminal::Error(ref c, _)
                if c == "input-limit-exceeded"),
        );
    }

    #[test]
    fn capture_loop_stream_error_returns_capture_unavailable() {
        use ringbuf::traits::Split;
        let mut cons = ringbuf::HeapRb::<f32>::new(8).split().1;
        let overflow = AtomicBool::new(false);
        let stream_error = AtomicBool::new(true);
        let clean_stop = AtomicBool::new(false);
        let cancel = AtomicBool::new(false);
        let mut dm = Downmixer::new(16_000).unwrap();
        let mut buf = CaptureBuffer::new();
        let mut last = Instant::now();
        let mut act = false;
        let emit_noop = |_: SessionEvent| {};

        let term = capture_loop(
            &mut cons, &overflow, &stream_error, &clean_stop,
            &cancel, &mut dm, &mut buf,
            Duration::from_secs(120), &mut last, &mut act,
            Instant::now(), 1, "request", &emit_noop,
        );
        assert!(
            matches!(term, LoopTerminal::Error(ref c, _)
                if c == "capture-unavailable"),
            "stream error must be capture-unavailable"
        );
    }

    #[test]
    fn capture_loop_clean_stop_returns_clean() {
        use ringbuf::traits::Split;
        let mut cons = ringbuf::HeapRb::<f32>::new(8).split().1;
        let overflow = AtomicBool::new(false);
        let stream_error = AtomicBool::new(false);
        let clean_stop = AtomicBool::new(true); // Pre-set.
        let cancel = AtomicBool::new(false);
        let mut dm = Downmixer::new(16_000).unwrap();
        let mut buf = CaptureBuffer::new();
        let mut last = Instant::now();
        let mut act = false;
        let emit_noop = |_: SessionEvent| {};

        let term = capture_loop(
            &mut cons, &overflow, &stream_error, &clean_stop,
            &cancel, &mut dm, &mut buf,
            Duration::from_secs(120), &mut last, &mut act,
            Instant::now(), 1, "request", &emit_noop,
        );
        assert!(matches!(term, LoopTerminal::Clean));
    }
}

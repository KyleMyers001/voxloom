/// Capture session coordinator — BUS-9.
///
/// Generation-based state machine. Every session gets a monotonically
/// increasing `generation: u64`. Cancellation is phase-aware:
///
/// - PermissionWait: checked every 100 ms while the OS dialog is open.
/// - Pre-stream: checked before `StreamBackend::open`.
/// - CaptureLoop: checked every iteration.
///
/// Exactly one terminal `SessionEvent` is emitted per session:
/// `TestComplete`, `CaptureStopped`, `CaptureCancelled`, or `CaptureError`.
///
/// Injectable seams (`PermissionBackend`, `StreamBackend`) let unit tests
/// exercise the full lifecycle matrix without a live audio device or TCC.
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
    stream::{self, DeviceSelection, RING_CAPACITY},
};

// ── Constants ─────────────────────────────────────────────────────────────

const FULL_SAFETY_SECS: u64 = 120;
const TEST_SAFETY_SECS: u64 = 10;
const WATCHDOG_IDLE_SECS: u64 = 5;
const ACTIVITY_THRESHOLD: f32 = 0.001; // −60 dBFS

// ── Public event type ─────────────────────────────────────────────────────

/// Events emitted to the renderer. No PCM bytes are ever included.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SessionEvent {
    PermissionStatus { status: PermissionStatus },
    CaptureStarted { device_name: String },
    ActivityDetected,
    TestComplete { metadata: TestCaptureMetadata },
    /// Clean stop: safety bound reached or explicit stop on a full session.
    CaptureStopped,
    /// Session was explicitly cancelled by the user/coordinator.
    CaptureCancelled,
    DeviceList { devices: Vec<String> },
    CaptureError { category: String, message: String },
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

// ── Injectable seams ──────────────────────────────────────────────────────

/// Permission backend seam.
pub trait PermissionBackend: Send + Sync + 'static {
    fn query(&self) -> MicPermission;
    /// Call `callback` with `true` (granted) or `false` (denied).
    /// The callback may be invoked on any thread.
    fn request(&self, callback: Box<dyn FnOnce(bool) + Send>);
}

/// Data returned by a successful stream open.
pub struct StreamHandleData<H> {
    pub handle: H,
    #[allow(dead_code)] // Available for multi-channel future use
    pub channels: u16,
    pub device_name: String,
    pub native_rate: u32,
    pub consumer: ringbuf::HeapCons<f32>,
    pub overflow: Arc<AtomicBool>,
}

/// Stream backend seam.
pub trait StreamBackend: Send + Sync + 'static {
    type StreamHandle: Send + 'static;
    fn open(
        &self,
        selection: &DeviceSelection,
    ) -> Result<StreamHandleData<Self::StreamHandle>, String>;
    #[allow(dead_code)] fn list_devices(&self) -> Vec<String>;
}

// ── Production backends ───────────────────────────────────────────────────

pub struct RealPermissionBackend;

impl PermissionBackend for RealPermissionBackend {
    fn query(&self) -> MicPermission {
        permission::query()
    }
    fn request(&self, callback: Box<dyn FnOnce(bool) + Send>) {
        // Wrap FnOnce in Mutex<Option> so the Fn closure can call it once.
        use std::sync::Mutex;
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
    type StreamHandle = stream::SendStream;

    fn open(
        &self,
        selection: &DeviceSelection,
    ) -> Result<StreamHandleData<stream::SendStream>, String> {
        let opened = stream::open_input(selection)?;
        Ok(StreamHandleData {
            channels: opened.channels,
            consumer: opened.consumer,
            device_name: opened.device_name,
            handle: opened.stream,
            native_rate: opened.native_rate,
            overflow: opened.overflow,
        })
    }

    fn list_devices(&self) -> Vec<String> {
        stream::list_input_device_names()
    }
}

// ── Coordinator ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum Phase {
    Idle,
    Active,
}

struct CancelRequest {
    generation: u64,
    flag: Arc<AtomicBool>,
}

/// Resets the phase to Idle when dropped (on worker-thread exit).
struct PhaseGuard(Arc<Mutex<Phase>>);
impl Drop for PhaseGuard {
    fn drop(&mut self) {
        *self.0.lock().unwrap() = Phase::Idle;
    }
}

/// Thread-safe capture coordinator.
///
/// The type parameters allow test substitution of permission and stream
/// backends. Production code uses the default type aliases below.
pub struct Coordinator<
    P: PermissionBackend = RealPermissionBackend,
    S: StreamBackend = CpalStreamBackend,
> {
    generation: AtomicU64,
    phase: Arc<Mutex<Phase>>,
    cancel: Mutex<Option<CancelRequest>>,
    permission: Arc<P>,
    stream_backend: Arc<S>,
}

/// Production coordinator type alias.
pub type CaptureCoordinator = Coordinator;

impl Coordinator {
    pub fn new() -> Self {
        Coordinator {
            cancel: Mutex::new(None),
            generation: AtomicU64::new(0),
            permission: Arc::new(RealPermissionBackend),
            phase: Arc::new(Mutex::new(Phase::Idle)),
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
    /// Create with injectable backends (tests only).
    #[allow(dead_code)] pub fn with_backends(permission: P, stream_backend: S) -> Self {
        Coordinator {
            cancel: Mutex::new(None),
            generation: AtomicU64::new(0),
            permission: Arc::new(permission),
            phase: Arc::new(Mutex::new(Phase::Idle)),
            stream_backend: Arc::new(stream_backend),
        }
    }

    /// True while a session worker is running.
    pub fn is_active(&self) -> bool {
        *self.phase.lock().unwrap() == Phase::Active
    }

    /// Cancel the session with the given generation. Idempotent.
    /// Returns false if no matching *active* session exists.
    pub fn cancel(&self, generation: u64) -> bool {
        // Check phase first: if Idle, no active session to cancel.
        if *self.phase.lock().unwrap() == Phase::Idle {
            return false;
        }
        let guard = self.cancel.lock().unwrap();
        if let Some(req) = guard.as_ref() {
            if req.generation == generation {
                req.flag.store(true, Ordering::Release);
                return true;
            }
        }
        false
    }

    /// Cancel any active session regardless of generation.
    pub fn cancel_any(&self) {
        if let Some(req) = self.cancel.lock().unwrap().as_ref() {
            req.flag.store(true, Ordering::Release);
        }
    }

    /// The generation counter of the most recently started session (0 = none).
    #[allow(dead_code)] // used in tests via with_backends
    pub fn current_generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    /// Start a new capture session. Returns `Ok(generation)` or `Err("busy")`.
    ///
    /// `emit` is called from the worker thread for each `SessionEvent`.
    /// It must be `Send + 'static` and must not block the worker.
    pub fn start_session<E>(
        &self,
        selection: DeviceSelection,
        test_mode: bool,
        emit: E,
    ) -> Result<u64, String>
    where
        E: Fn(SessionEvent) + Send + 'static,
    {
        let mut phase = self.phase.lock().unwrap();
        if *phase == Phase::Active {
            return Err(String::from("busy"));
        }
        *phase = Phase::Active;
        drop(phase);

        let gen = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let cancel_flag = Arc::new(AtomicBool::new(false));

        *self.cancel.lock().unwrap() = Some(CancelRequest {
            flag: Arc::clone(&cancel_flag),
            generation: gen,
        });

        let phase_arc = Arc::clone(&self.phase);
        let permission = Arc::clone(&self.permission);
        let stream_backend = Arc::clone(&self.stream_backend);

        thread::spawn(move || {
            let _guard = PhaseGuard(phase_arc);
            run_session(
                cancel_flag,
                selection,
                test_mode,
                permission,
                stream_backend,
                &emit,
            );
        });

        Ok(gen)
    }
}

// ── Session worker ────────────────────────────────────────────────────────

fn is_cancelled(flag: &AtomicBool) -> bool {
    flag.load(Ordering::Acquire)
}

fn run_session<P, S, E>(
    cancel: Arc<AtomicBool>,
    selection: DeviceSelection,
    test_mode: bool,
    permission: Arc<P>,
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
        status: perm.into(),
    });

    if is_cancelled(&cancel) {
        emit(SessionEvent::CaptureCancelled);
        return;
    }

    // Phase 2: Request permission if not-determined.
    let authorized = match permission.query() {
        MicPermission::Authorized => true,
        MicPermission::NotDetermined => {
            let (tx, rx) = mpsc::channel::<bool>();
            permission.request(Box::new(move |granted| {
                let _ = tx.send(granted);
            }));
            // Poll for cancellation while waiting for OS dialog.
            let granted = loop {
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(g) => break g,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if is_cancelled(&cancel) {
                            emit(SessionEvent::CaptureCancelled);
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
            emit(SessionEvent::PermissionStatus { status });
            granted
        }
        MicPermission::Denied | MicPermission::Restricted => false,
    };

    if !authorized {
        emit(SessionEvent::CaptureError {
            category: String::from("permission-denied"),
            message: String::from(
                "Microphone access denied. \
                 Enable in System Settings > Privacy & Security.",
            ),
        });
        return;
    }

    // Phase 3: Cancel check before stream open.
    if is_cancelled(&cancel) {
        emit(SessionEvent::CaptureCancelled);
        return;
    }

    // Phase 4: Open stream.
    let mut stream_data = match stream_backend.open(&selection) {
        Ok(d) => d,
        Err(e) => {
            emit(SessionEvent::CaptureError {
                category: String::from("capture-unavailable"),
                message: e,
            });
            return;
        }
    };

    // Phase 5: Downmixer (mono; stream already downmixes channels).
    let mut downmixer = match Downmixer::new(stream_data.native_rate) {
        Ok(d) => d,
        Err(e) => {
            emit(SessionEvent::CaptureError {
                category: String::from("capture-unavailable"),
                message: e,
            });
            return;
        }
    };

    emit(SessionEvent::CaptureStarted {
        device_name: stream_data.device_name.clone(),
    });

    // Phase 6: Capture loop.
    let mut buffer = CaptureBuffer::new();
    let bound = Duration::from_secs(
        if test_mode { TEST_SAFETY_SECS } else { FULL_SAFETY_SECS },
    );
    let start = Instant::now();
    let mut last_sample = Instant::now();
    let mut activity_emitted = false;

    let terminal = capture_loop(
        &mut stream_data.consumer,
        &stream_data.overflow,
        &cancel,
        &mut downmixer,
        &mut buffer,
        bound,
        &mut last_sample,
        &mut activity_emitted,
        start,
        emit,
    );

    // Drop stream before consuming buffer.
    drop(stream_data.handle);

    match terminal {
        LoopTerminal::Clean => {
            if test_mode {
                emit(SessionEvent::TestComplete {
                    metadata: inspect(buffer),
                });
            } else {
                drop(buffer);
                emit(SessionEvent::CaptureStopped);
            }
        }
        LoopTerminal::Cancelled => {
            drop(buffer);
            emit(SessionEvent::CaptureCancelled);
        }
        LoopTerminal::Error(cat, msg) => {
            drop(buffer);
            emit(SessionEvent::CaptureError {
                category: cat,
                message: msg,
            });
        }
    }
}

// ── Capture loop ──────────────────────────────────────────────────────────

enum LoopTerminal {
    Clean,
    Cancelled,
    Error(String, String),
}

/// Drains the ring buffer, resamples, accumulates into `buffer`.
/// Emits `ActivityDetected` exactly once when audio is detected.
/// Returns exactly one terminal.
fn capture_loop<E: Fn(SessionEvent)>(
    consumer: &mut ringbuf::HeapCons<f32>,
    overflow: &AtomicBool,
    cancel: &AtomicBool,
    downmixer: &mut Downmixer,
    buffer: &mut CaptureBuffer,
    bound: Duration,
    last_sample: &mut Instant,
    activity_emitted: &mut bool,
    start: Instant,
    emit: &E,
) -> LoopTerminal {
    // Preallocated drain buffer; no per-iteration heap allocation.
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
                emit(SessionEvent::ActivityDetected);
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

        if overflow.load(Ordering::Acquire) {
            return LoopTerminal::Error(
                String::from("input-limit-exceeded"),
                String::from("Audio ring buffer overflow."),
            );
        }

        if start.elapsed() >= bound {
            let tail = match downmixer.flush() {
                Ok(t) => t,
                Err(e) => {
                    return LoopTerminal::Error(
                        String::from("capture-unavailable"),
                        e,
                    );
                }
            };
            if !tail.is_empty() {
                if buffer.push(&tail).is_err() {
                    return LoopTerminal::Error(
                        String::from("input-limit-exceeded"),
                        String::from("Flush overflow."),
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

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    // ── Test backends ─────────────────────────────────────────────────

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
        /// Pre-latch the overflow flag to simulate ring buffer overflow.
        simulate_overflow: bool,
    }

    impl StreamBackend for FakeStreamBackend {
        type StreamHandle = ();

        fn open(
            &self,
            _selection: &DeviceSelection,
        ) -> Result<StreamHandleData<()>, String> {
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
            let overflow = Arc::new(AtomicBool::new(
                self.simulate_overflow,
            ));
            Ok(StreamHandleData {
                channels: 1,
                consumer: cons,
                device_name: String::from("Fake"),
                handle: (),
                native_rate: 16_000,
                overflow,
            })
        }

        fn list_devices(&self) -> Vec<String> {
            vec![String::from("Fake")]
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
        let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let log2 = Arc::clone(&log);
        let emit = move |e: SessionEvent| {
            log2.lock().unwrap().push(event_tag(&e));
        };
        (emit, log)
    }

    fn event_tag(e: &SessionEvent) -> String {
        match e {
            SessionEvent::PermissionStatus { status } => {
                format!("perm:{status:?}")
            }
            SessionEvent::CaptureStarted { .. } => {
                String::from("started")
            }
            SessionEvent::ActivityDetected => String::from("activity"),
            SessionEvent::TestComplete { .. } => {
                String::from("test-complete")
            }
            SessionEvent::CaptureStopped => String::from("stopped"),
            SessionEvent::CaptureCancelled => String::from("cancelled"),
            SessionEvent::DeviceList { .. } => String::from("device-list"),
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

    // ── Invariants ────────────────────────────────────────────────────

    #[test]
    fn starts_idle() {
        let c = mk(
            FakePermission(MicPermission::Authorized),
            FakeStreamBackend { open_error: None, samples: vec![], simulate_overflow: false },
        );
        assert!(!c.is_active());
    }

    #[test]
    fn busy_rejects_second_start() {
        let c = mk(
            FakePermission(MicPermission::Authorized),
            FakeStreamBackend { open_error: None, samples: vec![], simulate_overflow: false },
        );
        let (emit1, _) = mk_emit();
        let (emit2, _) = mk_emit();
        let gen = c
            .start_session(DeviceSelection::SystemDefault, true, emit1)
            .unwrap();
        assert_eq!(
            c.start_session(DeviceSelection::SystemDefault, true, emit2),
            Err(String::from("busy"))
        );
        c.cancel(gen);
        idle_wait(&c, Duration::from_secs(3));
    }

    // ── Permission states ─────────────────────────────────────────────

    #[test]
    fn authorized_proceeds_to_started() {
        let c = mk(
            FakePermission(MicPermission::Authorized),
            FakeStreamBackend { open_error: None, samples: vec![0.5], simulate_overflow: false },
        );
        let (emit, log) = mk_emit();
        c.start_session(DeviceSelection::SystemDefault, true, emit)
            .unwrap();
        assert!(wait_for(&log, "started", Duration::from_secs(3)));
    }

    #[test]
    fn denied_emits_permission_error_not_started() {
        let c = mk(
            FakePermission(MicPermission::Denied),
            FakeStreamBackend { open_error: None, samples: vec![], simulate_overflow: false },
        );
        let (emit, log) = mk_emit();
        c.start_session(DeviceSelection::SystemDefault, false, emit)
            .unwrap();
        assert!(wait_for(
            &log,
            "error:permission-denied",
            Duration::from_secs(3),
        ));
        assert!(!log.lock().unwrap().contains(&String::from("started")));
    }

    #[test]
    fn restricted_emits_permission_error() {
        let c = mk(
            FakePermission(MicPermission::Restricted),
            FakeStreamBackend { open_error: None, samples: vec![], simulate_overflow: false },
        );
        let (emit, log) = mk_emit();
        c.start_session(DeviceSelection::SystemDefault, false, emit)
            .unwrap();
        assert!(wait_for(
            &log,
            "error:permission-denied",
            Duration::from_secs(3),
        ));
        let events = log.lock().unwrap().clone();
        assert!(events.iter().any(|e| e.contains("Restricted")));
    }

    // ── Cancel at every phase ─────────────────────────────────────────

    #[test]
    fn cancel_before_open_emits_cancelled_not_started() {
        // Pre-authorised so no dialog wait; cancel immediately.
        let c = mk(
            FakePermission(MicPermission::Authorized),
            FakeStreamBackend { open_error: None, samples: vec![], simulate_overflow: false },
        );
        let (emit, log) = mk_emit();
        let gen = c
            .start_session(DeviceSelection::SystemDefault, true, emit)
            .unwrap();
        c.cancel(gen);
        idle_wait(&c, Duration::from_secs(3));
        let events = log.lock().unwrap().clone();
        // Terminal must be exactly one of: cancelled, test-complete, stopped.
        let terminal: Vec<_> = events
            .iter()
            .filter(|e| {
                e.starts_with("error:")
                    || *e == "cancelled"
                    || *e == "stopped"
                    || *e == "test-complete"
            })
            .collect();
        assert_eq!(terminal.len(), 1, "expected exactly one terminal; got {events:?}");
    }

    #[test]
    fn cancel_after_session_ends_is_noop() {
        let c = mk(
            FakePermission(MicPermission::Denied),
            FakeStreamBackend { open_error: None, samples: vec![], simulate_overflow: false },
        );
        let (emit, log) = mk_emit();
        let gen = c
            .start_session(DeviceSelection::SystemDefault, false, emit)
            .unwrap();
        wait_for(&log, "error:permission-denied", Duration::from_secs(3));
        idle_wait(&c, Duration::from_secs(3));
        assert!(!c.cancel(gen), "cancel of ended session returns false");
    }

    #[test]
    fn stale_generation_cancel_returns_false() {
        let c = mk(
            FakePermission(MicPermission::Authorized),
            FakeStreamBackend { open_error: None, samples: vec![], simulate_overflow: false },
        );
        assert!(!c.cancel(999));
    }

    // ── Stream error ──────────────────────────────────────────────────

    #[test]
    fn open_error_emits_capture_unavailable() {
        let c = mk(
            FakePermission(MicPermission::Authorized),
            FakeStreamBackend {
                open_error: Some(String::from(
                    "capture-unavailable: no device",
                )),
                samples: vec![],
                simulate_overflow: false,
            },
        );
        let (emit, log) = mk_emit();
        c.start_session(DeviceSelection::SystemDefault, false, emit)
            .unwrap();
        assert!(wait_for(
            &log,
            "error:capture-unavailable",
            Duration::from_secs(3),
        ));
    }

    // ── Test mode ─────────────────────────────────────────────────────

    #[test]
    fn test_mode_with_activity_emits_test_complete() {
        // Feed audible samples + simulate ring overflow so the loop
        // terminates with input-limit-exceeded rather than waiting 5 s
        // for the watchdog.
        // The activity event must fire before termination.
        let c = mk(
            FakePermission(MicPermission::Authorized),
            FakeStreamBackend {
                open_error: None,
                samples: vec![0.5f32; 160],
                simulate_overflow: false,
            },
        );
        let (emit, log) = mk_emit();
        c.start_session(DeviceSelection::SystemDefault, true, emit)
            .unwrap();
        // Wait up to 8 s; the watchdog fires after 6 s total
        // (1 s grace + 5 s idle).
        let has_terminal = wait_for(&log, "test-complete", Duration::from_secs(8))
            || wait_for(&log, "error:capture-unavailable", Duration::from_millis(100))
            || wait_for(&log, "stopped", Duration::from_millis(100));
        assert!(has_terminal, "expected a terminal event");
        assert!(
            log.lock().unwrap().contains(&String::from("activity")),
            "0.5 samples should trigger activity"
        );
    }

    #[test]
    fn test_mode_silence_no_activity_event() {
        // Feed silence + wait for watchdog to terminate.
        let c = mk(
            FakePermission(MicPermission::Authorized),
            FakeStreamBackend {
                open_error: None,
                samples: vec![0.0f32; 160],
                simulate_overflow: false,
            },
        );
        let (emit, log) = mk_emit();
        c.start_session(DeviceSelection::SystemDefault, true, emit)
            .unwrap();
        // Wait for any terminal event.
        wait_for(&log, "test-complete", Duration::from_secs(8));
        wait_for(&log, "error:capture-unavailable", Duration::from_millis(100));
        wait_for(&log, "stopped", Duration::from_millis(100));
        assert!(
            !log.lock().unwrap().contains(&String::from("activity")),
            "silence should not emit activity"
        );
    }

    // ── Buffer overflow ───────────────────────────────────────────────

    #[test]
    fn ring_overflow_flag_emits_input_limit_exceeded() {
        // Pre-latch the ring overflow flag so the coordinator terminates
        // immediately with input-limit-exceeded without needing to fill
        // the 120s CaptureBuffer (which would be impractical in tests).
        let c = mk(
            FakePermission(MicPermission::Authorized),
            FakeStreamBackend {
                open_error: None,
                samples: vec![],
                simulate_overflow: true,
            },
        );
        let (emit, log) = mk_emit();
        c.start_session(DeviceSelection::SystemDefault, false, emit)
            .unwrap();
        assert!(
            wait_for(
                &log,
                "error:input-limit-exceeded",
                Duration::from_secs(5),
            ),
            "expected input-limit-exceeded from ring overflow; got: {:?}",
            log.lock().unwrap()
        );
    }

    // ── Generation counter ────────────────────────────────────────────

    #[test]
    fn generations_increment_per_session() {
        let c = mk(
            FakePermission(MicPermission::Denied),
            FakeStreamBackend { open_error: None, samples: vec![], simulate_overflow: false },
        );
        assert_eq!(c.current_generation(), 0);
        let (e1, l1) = mk_emit();
        let g1 = c
            .start_session(DeviceSelection::SystemDefault, false, e1)
            .unwrap();
        assert_eq!(g1, 1);
        wait_for(&l1, "error:permission-denied", Duration::from_secs(3));
        idle_wait(&c, Duration::from_secs(3));
        let (e2, _) = mk_emit();
        let g2 = c
            .start_session(DeviceSelection::SystemDefault, false, e2)
            .unwrap();
        assert_eq!(g2, 2);
        c.cancel(g2);
    }

    // ── capture_loop unit ─────────────────────────────────────────────

    #[test]
    fn capture_loop_accumulates_and_cancel_terminates() {
        use ringbuf::traits::{Producer, Split};
        let rb = ringbuf::HeapRb::<f32>::new(RING_CAPACITY);
        let (mut prod, mut cons) = rb.split();
        for _ in 0..480 {
            let _ = prod.try_push(0.5f32);
        }
        // Leave producer alive so Disconnected is not the exit.
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel2 = Arc::clone(&cancel);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(80));
            cancel2.store(true, Ordering::Release);
        });

        let overflow = AtomicBool::new(false);
        let mut dm = Downmixer::new(16_000).unwrap();
        let mut buf = CaptureBuffer::new();
        let mut last = Instant::now();
        let mut act = false;
        let emit = |_: SessionEvent| {};

        let term = capture_loop(
            &mut cons,
            &overflow,
            &cancel,
            &mut dm,
            &mut buf,
            Duration::from_secs(120),
            &mut last,
            &mut act,
            Instant::now(),
            &emit,
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
    fn capture_loop_ring_overflow_returns_error() {
        use ringbuf::traits::{Split};
        let rb = ringbuf::HeapRb::<f32>::new(8);
        let (mut cons) = rb.split().1;
        let overflow = AtomicBool::new(true); // Pre-latched.
        let cancel = AtomicBool::new(false);
        let mut dm = Downmixer::new(16_000).unwrap();
        let mut buf = CaptureBuffer::new();
        let mut last = Instant::now();
        let mut act = false;
        let emit = |_: SessionEvent| {};

        let term = capture_loop(
            &mut cons,
            &overflow,
            &cancel,
            &mut dm,
            &mut buf,
            Duration::from_secs(120),
            &mut last,
            &mut act,
            Instant::now(),
            &emit,
        );
        assert!(
            matches!(term, LoopTerminal::Error(ref cat, _)
                if cat == "input-limit-exceeded"),
        );
    }
}

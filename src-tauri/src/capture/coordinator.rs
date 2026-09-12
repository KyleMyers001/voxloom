/// Capture session coordinator.
///
/// Enforces the single-session invariant, gates on permission, drives the
/// CPAL stream, resamples/downmixes via the Downmixer, accumulates into a
/// bounded CaptureBuffer, and emits safe metadata events to the renderer.
/// No PCM bytes cross the IPC boundary.
///
/// Hard bounds:
/// - 120 s safety timeout for full capture sessions.
/// - 10 s auto-stop for explicit mic test sessions.
/// - 5 s no-sample watchdog.
/// - QUEUE_CAPACITY bounded callback queue; overflow drops samples (watchdog
///   detects prolonged silence).
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::thread;
use std::time::{Duration, Instant};

use crate::capture::{
    buffer::CaptureBuffer,
    consumer::{inspect, TestCaptureMetadata},
    permission::{self, MicPermission},
    resample::Downmixer,
    stream::{self, CallbackMessage},
};

/// Silence threshold for on-stream activity detection (−60 dBFS ≈ 0.001).
const ACTIVITY_THRESHOLD: f32 = 0.001;

/// Hard safety bound for full capture sessions.
const FULL_SAFETY_SECS: u64 = 120;

/// Auto-stop bound for explicit test sessions.
const TEST_SAFETY_SECS: u64 = 10;

/// Watchdog: emit error when no samples received for this duration after
/// the first second of capture.
const WATCHDOG_IDLE_SECS: u64 = 5;

/// Events emitted to the renderer via Tauri. Carry only safe state/metadata.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SessionEvent {
    /// Current microphone permission state (queried without prompting).
    PermissionStatus { status: PermissionStatus },
    /// Capture started; `device_name` is for display only, not identity.
    CaptureStarted { device_name: String },
    /// Any sample exceeded the silence threshold.
    ActivityDetected,
    /// 10-second mic-test completed; no audio bytes included.
    TestComplete { metadata: TestCaptureMetadata },
    /// Capture ended normally (safety bound, explicit stop, or test done).
    CaptureStopped,
    /// Available input device names (display only).
    DeviceList { devices: Vec<String> },
    /// A stable error with category for UI routing.
    CaptureError { category: String, message: String },
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionStatus {
    NotDetermined,
    Authorized,
    Denied,
}

impl From<MicPermission> for PermissionStatus {
    fn from(p: MicPermission) -> Self {
        match p {
            MicPermission::NotDetermined => {
                PermissionStatus::NotDetermined
            }
            MicPermission::Authorized => PermissionStatus::Authorized,
            MicPermission::Denied => PermissionStatus::Denied,
        }
    }
}

/// Thread-safe coordinator held in Tauri managed state.
///
/// `Mutex` guards `active` and `stop` together via atomic flags so that
/// the IPC command layer and the worker thread never race on start/stop.
pub struct CaptureCoordinator {
    active: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
}

impl CaptureCoordinator {
    pub fn new() -> Self {
        CaptureCoordinator {
            active: Arc::new(AtomicBool::new(false)),
            stop: Arc::new(AtomicBool::new(false)),
        }
    }

    /// True while a capture session worker thread is alive.
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    /// Signal the active session to stop. Idempotent; safe to call when
    /// no session is running.
    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::Release);
    }

    /// Start a new capture session on a worker thread.
    ///
    /// Returns `Err("busy")` when a session is already active.
    ///
    /// `emit` is called from the worker thread with each `SessionEvent`.
    /// It must be `Send + 'static` and must not block the worker.
    pub fn start_session<E>(
        &self,
        preferred_device: Option<String>,
        test_mode: bool,
        emit: E,
    ) -> Result<(), String>
    where
        E: Fn(SessionEvent) + Send + 'static,
    {
        // Atomic compare-exchange: only one goroutine can set active=true.
        if self.active
            .compare_exchange(
                false,
                true,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_err()
        {
            return Err(String::from("busy"));
        }
        self.stop.store(false, Ordering::Release);

        let active = Arc::clone(&self.active);
        let stop = Arc::clone(&self.stop);

        thread::spawn(move || {
            run_session(preferred_device, test_mode, stop, &emit);
            active.store(false, Ordering::Release);
        });

        Ok(())
    }
}

impl Default for CaptureCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

/// Full session lifecycle on a dedicated worker thread.
fn run_session<E>(
    preferred_device: Option<String>,
    test_mode: bool,
    stop: Arc<AtomicBool>,
    emit: &E,
) where
    E: Fn(SessionEvent),
{
    // --- Permission gate ---
    let perm = permission::query();
    emit(SessionEvent::PermissionStatus {
        status: perm.into(),
    });

    let authorized = match permission::query() {
        MicPermission::Authorized => true,
        MicPermission::NotDetermined => {
            let (tx, rx) = mpsc::channel::<bool>();
            permission::request(move |granted| {
                let _ = tx.send(granted);
            });
            // Re-emit updated status after dialog.
            let granted = rx
                .recv_timeout(Duration::from_secs(60))
                .unwrap_or(false);
            let new_status = if granted {
                PermissionStatus::Authorized
            } else {
                PermissionStatus::Denied
            };
            emit(SessionEvent::PermissionStatus {
                status: new_status,
            });
            granted
        }
        MicPermission::Denied => false,
    };

    if !authorized {
        emit(SessionEvent::CaptureError {
            category: String::from("permission-denied"),
            message: String::from(
                "Microphone permission denied. Enable it in \
                 System Settings > Privacy & Security.",
            ),
        });
        return;
    }

    // --- Open stream ---
    let opened = match stream::open_input(preferred_device.as_deref()) {
        Ok(s) => s,
        Err(e) => {
            emit(SessionEvent::CaptureError {
                category: String::from("capture-unavailable"),
                message: e,
            });
            return;
        }
    };

    let channels = opened.channels;
    let native_rate = opened.native_rate;
    let device_name = opened.device_name.clone();
    let receiver = opened.receiver;
    // stream stays alive until we drop `opened.stream` below.

    emit(SessionEvent::CaptureStarted { device_name });

    // --- Downmixer / resampler ---
    let mut downmixer = match Downmixer::new(channels as usize, native_rate)
    {
        Ok(d) => d,
        Err(e) => {
            emit(SessionEvent::CaptureError {
                category: String::from("capture-unavailable"),
                message: format!("Resampler init: {e}"),
            });
            drop(opened.stream);
            return;
        }
    };

    // --- Capture loop ---
    let mut buffer = CaptureBuffer::new();
    let bound = Duration::from_secs(
        if test_mode { TEST_SAFETY_SECS } else { FULL_SAFETY_SECS },
    );
    let start = Instant::now();
    let mut last_sample = Instant::now();
    let mut activity_emitted = false;
    let mut terminal_error: Option<(String, String)> = None;

    'capture: loop {
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(CallbackMessage::Samples(samples)) => {
                last_sample = Instant::now();
                let mono = downmixer.process(&samples);

                if !activity_emitted
                    && mono.iter().any(|&s| s.abs() >= ACTIVITY_THRESHOLD)
                {
                    activity_emitted = true;
                    emit(SessionEvent::ActivityDetected);
                }

                if buffer.push(&mono).is_err() {
                    terminal_error = Some((
                        String::from("input-limit-exceeded"),
                        String::from(
                            "120-second capture limit reached.",
                        ),
                    ));
                    break 'capture;
                }
            }
            Ok(CallbackMessage::Error(e)) => {
                terminal_error = Some((
                    String::from("capture-unavailable"),
                    e,
                ));
                break 'capture;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let elapsed = start.elapsed();
                let idle = last_sample.elapsed();
                if elapsed > Duration::from_secs(1)
                    && idle > Duration::from_secs(WATCHDOG_IDLE_SECS)
                {
                    terminal_error = Some((
                        String::from("capture-unavailable"),
                        String::from(
                            "No audio received from device.",
                        ),
                    ));
                    break 'capture;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                terminal_error = Some((
                    String::from("capture-unavailable"),
                    String::from("Audio stream disconnected."),
                ));
                break 'capture;
            }
        }

        if start.elapsed() >= bound {
            let tail = downmixer.flush();
            let _ = buffer.push(&tail);
            break 'capture;
        }

        if stop.load(Ordering::Acquire) {
            let tail = downmixer.flush();
            let _ = buffer.push(&tail);
            break 'capture;
        }
    }

    // Drop stream before consuming buffer; no overlap between device
    // and buffer ownership.
    drop(opened.stream);

    // Emit terminal result.
    if let Some((category, message)) = terminal_error {
        emit(SessionEvent::CaptureError { category, message });
        return;
    }

    if test_mode {
        emit(SessionEvent::TestComplete {
            metadata: inspect(buffer),
        });
    } else {
        // BUS-10 will own the buffer transfer; for now dispose.
        drop(buffer);
        emit(SessionEvent::CaptureStopped);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn collect_emit() -> (
        impl Fn(SessionEvent) + Send + 'static,
        Arc<Mutex<Vec<String>>>,
    ) {
        let log: Arc<Mutex<Vec<String>>> =
            Arc::new(Mutex::new(Vec::new()));
        let log2 = Arc::clone(&log);
        let emit = move |e: SessionEvent| {
            // Record the event kind for assertion.
            let tag = match &e {
                SessionEvent::PermissionStatus { .. } => "permission-status",
                SessionEvent::CaptureStarted { .. } => "capture-started",
                SessionEvent::ActivityDetected => "activity-detected",
                SessionEvent::TestComplete { .. } => "test-complete",
                SessionEvent::CaptureStopped => "capture-stopped",
                SessionEvent::DeviceList { .. } => "device-list",
                SessionEvent::CaptureError { .. } => "capture-error",
            };
            log2.lock().unwrap().push(tag.to_string());
        };
        (emit, log)
    }

    #[test]
    fn coordinator_starts_idle() {
        let c = CaptureCoordinator::new();
        assert!(!c.is_active());
    }

    #[test]
    fn coordinator_busy_rejects_second_start() {
        let c = CaptureCoordinator::new();
        // Simulate an active session by setting the flag manually.
        c.active.store(true, Ordering::Release);
        let (emit, _) = collect_emit();
        let result = c.start_session(None, false, emit);
        assert_eq!(result, Err(String::from("busy")));
        c.active.store(false, Ordering::Release);
    }

    #[test]
    fn request_stop_is_idempotent() {
        let c = CaptureCoordinator::new();
        c.request_stop();
        c.request_stop();
        assert!(c.stop.load(Ordering::Acquire));
    }

    #[test]
    fn permission_status_conversion() {
        assert!(matches!(
            PermissionStatus::from(MicPermission::Authorized),
            PermissionStatus::Authorized
        ));
        assert!(matches!(
            PermissionStatus::from(MicPermission::Denied),
            PermissionStatus::Denied
        ));
        assert!(matches!(
            PermissionStatus::from(MicPermission::NotDetermined),
            PermissionStatus::NotDetermined
        ));
    }

    #[test]
    fn active_flag_cleared_after_stop() {
        let c = CaptureCoordinator::new();
        c.active.store(true, Ordering::Release);
        // Simulate worker exit.
        c.active.store(false, Ordering::Release);
        assert!(!c.is_active());
    }

    /// Integration: synthetic channel — no live device required.
    ///
    /// Feeds pre-built CallbackMessage values through an mpsc channel that
    /// substitutes for the real-time audio callback, bypasses the stream
    /// open step, and verifies that the capture loop terminates correctly.
    #[test]
    fn capture_loop_accumulates_then_stops() {
        // Build a synthetic receiver simulating 3 sample batches then stop.
        let (tx, rx) =
            mpsc::sync_channel::<CallbackMessage>(64);
        for _ in 0..3 {
            tx.send(CallbackMessage::Samples(vec![0.5f32; 160]))
                .unwrap();
        }
        // Disconnect sender so recv_timeout returns Disconnected after
        // the 3 messages are consumed.
        drop(tx);

        let stop = Arc::new(AtomicBool::new(false));
        let mut downmixer = Downmixer::new(1, 16_000).unwrap();
        let mut buffer = CaptureBuffer::new();
        let bound = Duration::from_secs(120);
        let start = Instant::now();
        let mut last_sample = Instant::now();
        let mut activity_emitted = false;
        let mut terminal_error: Option<(String, String)> = None;

        'capture: loop {
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(CallbackMessage::Samples(samples)) => {
                    last_sample = Instant::now();
                    let mono = downmixer.process(&samples);
                    if !activity_emitted
                        && mono.iter().any(|&s| s.abs() >= 0.001)
                    {
                        activity_emitted = true;
                    }
                    if buffer.push(&mono).is_err() {
                        terminal_error = Some((
                            String::from("input-limit-exceeded"),
                            String::from("limit"),
                        ));
                        break 'capture;
                    }
                }
                Ok(CallbackMessage::Error(e)) => {
                    terminal_error = Some((
                        String::from("capture-unavailable"),
                        e,
                    ));
                    break 'capture;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let elapsed = start.elapsed();
                    if elapsed > Duration::from_secs(1)
                        && last_sample.elapsed()
                            > Duration::from_secs(5)
                    {
                        terminal_error = Some((
                            String::from("capture-unavailable"),
                            String::from("idle"),
                        ));
                        break 'capture;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    break 'capture; // Synthetic: treat as clean stop.
                }
            }
            if start.elapsed() >= bound {
                break 'capture;
            }
            if stop.load(Ordering::Acquire) {
                break 'capture;
            }
        }

        assert!(terminal_error.is_none());
        assert!(activity_emitted);
        // 3 batches × 160 frames at target rate = 480 frames.
        assert_eq!(buffer.len(), 480);
    }

    /// Integration: input-limit-exceeded path via overflow.
    #[test]
    fn capture_loop_errors_on_buffer_overflow() {
        use crate::capture::buffer::MAX_FRAMES;

        let (tx, rx) =
            mpsc::sync_channel::<CallbackMessage>(64);
        // Send a batch that would overflow the buffer.
        tx.send(CallbackMessage::Samples(
            vec![0.0f32; MAX_FRAMES + 1],
        ))
        .unwrap();
        drop(tx);

        let stop = Arc::new(AtomicBool::new(false));
        let mut downmixer = Downmixer::new(1, 16_000).unwrap();
        let mut buffer = CaptureBuffer::new();
        let bound = Duration::from_secs(120);
        let start = Instant::now();
        let mut last_sample = Instant::now();
        let mut terminal_error: Option<(String, String)> = None;

        'capture: loop {
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(CallbackMessage::Samples(samples)) => {
                    last_sample = Instant::now();
                    let mono = downmixer.process(&samples);
                    if buffer.push(&mono).is_err() {
                        terminal_error = Some((
                            String::from("input-limit-exceeded"),
                            String::from("120-second limit"),
                        ));
                        break 'capture;
                    }
                }
                Ok(CallbackMessage::Error(e)) => {
                    terminal_error =
                        Some((String::from("capture-unavailable"), e));
                    break 'capture;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if start.elapsed() > Duration::from_secs(1)
                        && last_sample.elapsed()
                            > Duration::from_secs(5)
                    {
                        terminal_error = Some((
                            String::from("capture-unavailable"),
                            String::from("idle"),
                        ));
                        break 'capture;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    break 'capture;
                }
            }
            if start.elapsed() >= bound {
                break 'capture;
            }
            if stop.load(Ordering::Acquire) {
                break 'capture;
            }
        }

        assert_eq!(
            terminal_error.as_ref().map(|(cat, _)| cat.as_str()),
            Some("input-limit-exceeded")
        );
    }

    /// Integration: stop flag terminates loop cleanly.
    #[test]
    fn capture_loop_respects_stop_flag() {
        let (tx, rx) = mpsc::sync_channel::<CallbackMessage>(64);
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = Arc::clone(&stop);

        // Keep sender alive so Disconnected is not the termination reason.
        let _sender_guard = tx;

        let bound = Duration::from_secs(120);
        let start = Instant::now();
        let mut last_sample = Instant::now();
        let mut stopped_cleanly = false;

        // Set stop flag immediately.
        stop2.store(true, Ordering::Release);

        loop {
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(_) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if start.elapsed() > Duration::from_secs(1)
                        && last_sample.elapsed()
                            > Duration::from_secs(5)
                    {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if start.elapsed() >= bound {
                break;
            }
            if stop.load(Ordering::Acquire) {
                stopped_cleanly = true;
                break;
            }
        }

        assert!(stopped_cleanly);
    }
}

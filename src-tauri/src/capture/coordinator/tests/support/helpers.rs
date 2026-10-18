use super::super::*;

pub(crate) fn mk<P: PermissionBackend, S: StreamBackend>(p: P, s: S) -> Coordinator<P, S> {
    Coordinator::with_backends(p, s)
}

pub(crate) fn mk_timed<P: PermissionBackend, S: StreamBackend>(
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

pub(crate) fn mk_emit() -> (
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

pub(crate) fn event_tag(e: &SessionEvent) -> String {
    match e {
        SessionEvent::PermissionStatus { status, .. } => {
            format!("perm:{status:?}")
        }
        SessionEvent::CaptureStarted { .. } => String::from("started"),
        SessionEvent::ActivityDetected { .. } => String::from("activity"),
        SessionEvent::CaptureLevel { .. } => String::from("level"),
        SessionEvent::TestComplete { .. } => String::from("test-complete"),
        SessionEvent::CaptureStopped { .. } => String::from("stopped"),
        SessionEvent::CaptureCancelled { .. } => String::from("cancelled"),
        SessionEvent::CaptureError { category, .. } => {
            format!("error:{category}")
        }
    }
}

pub(crate) fn wait_for(log: &Arc<Mutex<Vec<String>>>, tag: &str, timeout: Duration) -> bool {
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

pub(crate) fn idle_wait(c: &impl IsActive, timeout: Duration) {
    let start = Instant::now();
    while c.is_active() && start.elapsed() < timeout {
        thread::sleep(Duration::from_millis(5));
    }
}

pub(crate) trait IsActive {
    fn is_active(&self) -> bool;
}
impl<P: PermissionBackend, S: StreamBackend> IsActive for Coordinator<P, S> {
    fn is_active(&self) -> bool {
        Coordinator::is_active(self)
    }
}

pub(crate) fn authorized_backend(samples: Vec<f32>) -> (FakePermission, FakeStreamBackend) {
    (
        FakePermission(MicPermission::Authorized),
        FakeStreamBackend::new(samples),
    )
}

// Invariants

pub(crate) fn wait_for_event(
    events: &Arc<Mutex<Vec<SessionEvent>>>,
    pred: impl Fn(&SessionEvent) -> bool,
    timeout: Duration,
) -> bool {
    let start = Instant::now();
    loop {
        if events.lock().unwrap().iter().any(&pred) {
            return true;
        }
        if start.elapsed() > timeout {
            return false;
        }
        thread::sleep(Duration::from_millis(5));
    }
}

pub(crate) fn run_immediate_loop(
    consumer: &mut ringbuf::HeapCons<f32>,
    overflow: &AtomicBool,
    stream_error: &AtomicBool,
) -> LoopTerminal {
    let accepting = open_gate();
    run_immediate_loop_with_gate(consumer, &accepting, overflow, stream_error)
}

pub(crate) fn run_immediate_loop_with_gate(
    consumer: &mut ringbuf::HeapCons<f32>,
    accepting: &CaptureGate,
    overflow: &AtomicBool,
    stream_error: &AtomicBool,
) -> LoopTerminal {
    let callbacks_in_flight = AtomicUsize::new(0);
    let cancel = AtomicBool::new(false);
    let stop = AtomicBool::new(false);
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
        &stop,
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

use super::*;

#[test]
fn level_meter_is_rate_limited_and_returns_silence_without_samples() {
    let mut meter = LevelMeter::new(Duration::ZERO);
    meter.observe(&[0.5, -0.5]);
    assert_eq!(meter.take_if_due(Duration::from_millis(40)), None);
    assert_eq!(meter.take_if_due(Duration::from_millis(50)), Some(0.5));
    assert_eq!(meter.take_if_due(Duration::from_millis(60)), None);
    assert_eq!(meter.take_if_due(Duration::from_millis(100)), Some(0.0));
    meter.observe(&[2.0, 2.0]);
    assert_eq!(meter.take_if_due(Duration::from_millis(150)), Some(1.0));
}

// capture_loop unit

#[test]
fn capture_loop_accumulates_then_cancel_terminates() {
    use ringbuf::traits::{Producer, Split};
    let rb = ringbuf::HeapRb::<f32>::new(RING_CAPACITY);
    let (mut producer, mut consumer) = rb.split();
    assert_eq!(producer.push_slice(&[0.5; 480]), 480);
    // Cancel only once the loop has drained the samples and reported their
    // level, so the test does not race a wall-clock sleep (BUS-55).
    let cancel = AtomicBool::new(false);
    let stop = AtomicBool::new(false);
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
    let events = Mutex::new(Vec::new());

    let terminal = capture_loop(
        &mut consumer,
        &accepting,
        &callbacks_in_flight,
        &overflow,
        &stream_error,
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
        &|event| {
            if matches!(event, SessionEvent::CaptureLevel { level, .. } if level > 0.0) {
                cancel.store(true, Ordering::Release);
            }
            events.lock().unwrap().push(event);
        },
        &runtime,
    );

    assert!(matches!(terminal, LoopTerminal::Cancelled));
    assert!(activity);
    assert_eq!(buffer.len(), 480);
    assert!(events.lock().unwrap().iter().any(|event| matches!(
        event,
        SessionEvent::CaptureLevel {
            generation: 1,
            request_id,
            level,
        } if request_id == "request" && (*level - 0.5).abs() < 1e-6
    )));
}

#[test]
fn capture_loop_overflow_returns_input_limit_exceeded() {
    use ringbuf::traits::Split;
    let mut consumer = ringbuf::HeapRb::<f32>::new(8).split().1;
    let overflow = AtomicBool::new(true);
    let stream_error = AtomicBool::new(false);
    let terminal = run_immediate_loop(&mut consumer, &overflow, &stream_error);
    assert!(matches!(terminal, LoopTerminal::Error(ref category, _)
        if category == "input-limit-exceeded"));
}

#[test]
fn capture_loop_stream_error_returns_capture_unavailable() {
    use ringbuf::traits::Split;
    let mut consumer = ringbuf::HeapRb::<f32>::new(8).split().1;
    let overflow = AtomicBool::new(false);
    let stream_error = AtomicBool::new(true);
    let terminal = run_immediate_loop(&mut consumer, &overflow, &stream_error);
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
    let terminal =
        run_immediate_loop_with_gate(&mut consumer, &accepting, &overflow, &stream_error);
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
    let stop = AtomicBool::new(false);
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
        &stop,
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

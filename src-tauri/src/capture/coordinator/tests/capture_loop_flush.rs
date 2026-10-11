use super::*;

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
    let stop = AtomicBool::new(false);
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
        &stop,
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
fn capture_loop_flush_over_capacity_still_ends_clean() {
    use ringbuf::traits::{Producer, Split};
    let rb = ringbuf::HeapRb::<f32>::new(8);
    let (mut producer, mut consumer) = rb.split();
    assert_eq!(producer.push_slice(&[0.5; 3]), 3);
    let accepting = open_gate();
    let callbacks_in_flight = AtomicUsize::new(0);
    let overflow = AtomicBool::new(false);
    let stream_error = AtomicBool::new(false);
    let cancel = AtomicBool::new(false);
    let stop = AtomicBool::new(false);
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

    assert!(
        matches!(terminal, LoopTerminal::Clean),
        "capacity / flush limit must deposit via Clean, not error"
    );
    assert_eq!(downmixer.flush_calls(), 1);
    assert_eq!(buffer.len(), MAX_FRAMES);
    assert!(!accepting.is_open());
}

#[test]
fn capture_loop_buffer_capacity_returns_clean_not_error() {
    use ringbuf::traits::{Producer, Split};
    let rb = ringbuf::HeapRb::<f32>::new(512);
    let (mut producer, mut consumer) = rb.split();
    assert_eq!(producer.push_slice(&[0.5; 64]), 64);
    let accepting = open_gate();
    let callbacks_in_flight = AtomicUsize::new(0);
    let overflow = AtomicBool::new(false);
    let stream_error = AtomicBool::new(false);
    let cancel = AtomicBool::new(false);
    let stop = AtomicBool::new(false);
    let mut downmixer = Downmixer::new(TARGET_RATE).unwrap();
    let mut buffer = CaptureBuffer::new();
    buffer.push(&vec![0.0; MAX_FRAMES]).unwrap();
    let runtime = VirtualRuntime::default();
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
    );

    assert!(
        matches!(terminal, LoopTerminal::Clean),
        "120 s / capacity limit must end Clean so PCM can deposit"
    );
    assert_eq!(buffer.len(), MAX_FRAMES);
}

#[test]
fn capture_loop_user_stop_returns_clean() {
    use ringbuf::traits::{Producer, Split};
    let rb = ringbuf::HeapRb::<f32>::new(RING_CAPACITY);
    let (mut producer, mut consumer) = rb.split();
    assert_eq!(producer.push_slice(&[0.5; 480]), 480);
    let cancel = AtomicBool::new(false);
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_thread = Arc::clone(&stop);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(80));
        stop_for_thread.store(true, Ordering::Release);
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
        stop.as_ref(),
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

    assert!(matches!(terminal, LoopTerminal::Clean));
    assert!(buffer.len() >= 480);
}

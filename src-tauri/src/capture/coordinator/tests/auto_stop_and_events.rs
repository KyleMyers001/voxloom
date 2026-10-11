use super::*;

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
    )
    .unwrap();
    assert!(
        wait_for(&log, "error:input-limit-exceeded", Duration::from_secs(5),),
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
    let events: Arc<Mutex<Vec<SessionEvent>>> = Arc::new(Mutex::new(Vec::new()));
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
        let has_tc = events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, SessionEvent::TestComplete { .. }));
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
            | SessionEvent::CaptureLevel {
                generation,
                request_id,
                ..
            }
            | SessionEvent::TestComplete {
                generation,
                request_id,
                ..
            }
            | SessionEvent::CaptureStopped {
                generation,
                request_id,
                ..
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

use super::*;

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
            terminal_log
                .lock()
                .unwrap()
                .push((generation, request_id, event_runtime.elapsed()));
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
        *observed_status.lock().unwrap() = ten_second_coordinator.status();
        observed_count.store(event_count.load(Ordering::Acquire), Ordering::Release);
    });

    let terminals = Arc::new(Mutex::new(Vec::new()));
    let terminal_log = Arc::clone(&terminals);
    let event_runtime = runtime.clone();
    let event_count = Arc::clone(&terminal_count);
    let emit = move |event: SessionEvent| {
        if let SessionEvent::CaptureStopped {
            generation,
            request_id,
            audio: _,
        } = event
        {
            event_count.fetch_add(1, Ordering::AcqRel);
            terminal_log
                .lock()
                .unwrap()
                .push((generation, request_id, event_runtime.elapsed()));
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
    )
    .unwrap();
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
    let terminals: Vec<_> = events
        .iter()
        .filter(|e| {
            e.starts_with("error:") || *e == "cancelled" || *e == "stopped" || *e == "test-complete"
        })
        .collect();
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
    )
    .unwrap();
    assert!(wait_for(&log, "test-complete", Duration::from_secs(5)));
    assert!(
        !log.lock().unwrap().contains(&String::from("activity")),
        "silence must not emit activity"
    );
}

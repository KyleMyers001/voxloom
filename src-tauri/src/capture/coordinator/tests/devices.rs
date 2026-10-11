use super::*;

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
                    if let SessionEvent::CaptureStarted { device_name, .. } = event {
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
            error: Some(String::from("capture-unavailable: enumeration failed")),
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
    )
    .unwrap();
    assert!(
        wait_for(&log, "error:capture-unavailable", Duration::from_secs(3),),
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

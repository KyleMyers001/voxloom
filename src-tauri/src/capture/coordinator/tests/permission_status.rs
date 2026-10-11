use super::*;

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
    )
    .unwrap();
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
    )
    .unwrap();
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
    )
    .unwrap();
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
    let terminals: Vec<_> = events
        .iter()
        .filter(|e| {
            e.starts_with("error:") || *e == "cancelled" || *e == "stopped" || *e == "test-complete"
        })
        .collect();
    assert_eq!(terminals.len(), 1, "exactly one terminal; got: {events:?}");
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
            open_error: Some(String::from("capture-unavailable: no device")),
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
    assert!(wait_for(
        &log,
        "error:capture-unavailable",
        Duration::from_secs(3),
    ));
}

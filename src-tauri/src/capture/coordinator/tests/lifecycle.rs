use super::*;

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
        if matches!(event, SessionEvent::CaptureError { .. }) {
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
        cancelled_terminals, 1,
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
    assert!(wait_for(&next_log, "started", Duration::from_secs(3),));
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
        unrelated_terminals, 0,
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

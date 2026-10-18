use super::*;

#[test]
fn stop_any_deposits_pcm_and_emits_capture_stopped_with_audio() {
    let store = Arc::new(PcmBufferStore::new());
    let c = Coordinator::with_backends_store(
        FakePermission(MicPermission::Authorized),
        FakeStreamBackend::new(vec![0.5f32; 480]),
        Arc::clone(&store),
    );
    let events: Arc<Mutex<Vec<SessionEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let events2 = Arc::clone(&events);
    let status = c
        .start_session(
            String::from("stop-deposit"),
            DeviceSelection::SystemDefault,
            false,
            move |e| {
                events2.lock().unwrap().push(e);
            },
        )
        .unwrap();
    assert!(wait_for_event(
        &events,
        |e| { matches!(e, SessionEvent::CaptureStarted { .. }) },
        Duration::from_secs(3)
    ));
    c.stop_any();
    assert!(wait_for_event(
        &events,
        |e| { matches!(e, SessionEvent::CaptureStopped { .. }) },
        Duration::from_secs(3)
    ));
    idle_wait(&c, Duration::from_secs(3));

    let evs = events.lock().unwrap().clone();
    let stopped = evs.iter().find_map(|e| match e {
        SessionEvent::CaptureStopped {
            generation,
            request_id,
            audio,
        } => {
            assert_eq!(*generation, status.generation);
            assert_eq!(request_id, &status.request_id);
            Some(audio.clone())
        }
        _ => None,
    });
    let audio = stopped
        .expect("stop must emit CaptureStopped")
        .expect("stop must deposit non-empty PCM");
    assert!(!audio.id.is_empty());
    assert_eq!(store.len(), 1);
    assert!(store.take(&audio.id).is_some());
    assert!(!evs.iter().any(|e| matches!(
        e,
        SessionEvent::CaptureError { .. } | SessionEvent::CaptureCancelled { .. }
    )));
}

#[test]
fn cancel_any_discards_pcm_without_deposit() {
    let store = Arc::new(PcmBufferStore::new());
    let c = Coordinator::with_backends_store(
        FakePermission(MicPermission::Authorized),
        FakeStreamBackend::new(vec![0.5f32; 480]),
        Arc::clone(&store),
    );
    let events: Arc<Mutex<Vec<SessionEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let events2 = Arc::clone(&events);
    c.start_session(
        String::from("cancel-discard"),
        DeviceSelection::SystemDefault,
        false,
        move |e| {
            events2.lock().unwrap().push(e);
        },
    )
    .unwrap();
    assert!(wait_for_event(
        &events,
        |e| { matches!(e, SessionEvent::CaptureStarted { .. }) },
        Duration::from_secs(3)
    ));
    c.cancel_any();
    assert!(wait_for_event(
        &events,
        |e| { matches!(e, SessionEvent::CaptureCancelled { .. }) },
        Duration::from_secs(3)
    ));
    idle_wait(&c, Duration::from_secs(3));

    assert_eq!(store.len(), 0, "cancel must not deposit PCM");
    let evs = events.lock().unwrap();
    assert!(evs
        .iter()
        .any(|e| matches!(e, SessionEvent::CaptureCancelled { .. })));
    assert!(!evs
        .iter()
        .any(|e| matches!(e, SessionEvent::CaptureStopped { .. })));
}

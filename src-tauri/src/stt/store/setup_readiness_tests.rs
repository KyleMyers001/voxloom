//! Strict setup regressions; no inference, network or OS permission calls.
use super::tests::temp_store;
use super::Inflight;
use crate::stt::parakeet_catalog as pc;
use std::fs;
use std::sync::{atomic::AtomicBool, Arc};
use tauri::Manager;

fn readiness(app: &tauri::App<tauri::test::MockRuntime>, id: &str) -> serde_json::Value {
    serde_json::to_value(
        tauri::async_runtime::block_on(crate::setup_permissions::setup_model_readiness(
            app.state::<crate::stt::SttState>(),
            id.to_owned(),
        ))
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn setup_readiness_rejects_pending_corrupt_modified_and_downloading_parakeet() {
    let (store, dir) = temp_store("setup-parakeet-strict");
    let spec = pc::find("parakeet-tdt-0.6b-v3").unwrap();
    // Real pinned paths and sizes, sparse corrupt bytes. No model download.
    for file in spec.files {
        let path = dir.join(spec.id).join(file.path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::File::create(path)
            .unwrap()
            .set_len(file.size_bytes)
            .unwrap();
    }
    let state = crate::stt::SttState::new(
        store,
        Arc::new(crate::capture::pcm_store::PcmBufferStore::new()),
    );
    let models = state.models.clone();
    let hashing = models.hashing.lock().unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    models.set_on_models_changed(Arc::new(move || {
        let _ = send.send(());
    }));
    let startup = models.spawn_verify_existing(|| {});
    assert_eq!(models.cached_parakeet_verdict(spec), None);
    assert_eq!(models.status(spec.id).unwrap().status, "available");
    // Dictation remains deliberately permissive pending background hashing.
    assert_eq!(models.resolved_path(spec.id).is_ok(), pc::is_supported());
    let pending_direct = models.setup_verified(spec.id);
    let app = tauri::test::mock_builder()
        .manage(state)
        .build(crate::app_context())
        .unwrap();
    // The real handler exercises strict asset readiness when a worker exists;
    // model-store tests must also run in checkouts without a packaged worker.
    let engine_available =
        pc::is_supported() && crate::stt::parakeet::worker_path::installed().is_file();
    let pending_wire = readiness(&app, spec.id);
    *models.inflight.lock().unwrap() = Some((
        spec.id.to_owned(),
        Inflight {
            cancel: Arc::new(AtomicBool::new(false)),
        },
    ));
    let downloading_direct = models.setup_verified(spec.id);
    let downloading_wire = readiness(&app, spec.id);
    *models.inflight.lock().unwrap() = None;
    drop(hashing);
    startup.join().unwrap();
    // The ordinary resolver above queued a real re-verifier; join its completion
    // notification before modifying/removing its fixture directory.
    receive
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    assert_eq!(models.cached_parakeet_verdict(spec), Some(false));
    let corrupt_direct = models.setup_verified(spec.id);
    let corrupt_wire = readiness(&app, spec.id);
    let hashing = models.hashing.lock().unwrap();
    let first = dir.join(spec.id).join(spec.files[0].path);
    fs::File::create(first)
        .unwrap()
        .set_len(spec.files[0].size_bytes)
        .unwrap();
    assert_eq!(models.cached_parakeet_verdict(spec), None);
    assert_eq!(models.status(spec.id).unwrap().status, "available");
    let modified_direct = models.setup_verified(spec.id);
    let modified_wire = readiness(&app, spec.id);
    drop(hashing);
    receive
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    println!(
        "SETUP_READINESS {:?}",
        [
            &pending_wire,
            &downloading_wire,
            &corrupt_wire,
            &modified_wire
        ]
    );
    fs::remove_dir_all(dir).unwrap();
    for (label, direct, wire, status) in [
        ("pending", pending_direct, pending_wire, "pending"),
        (
            "downloading",
            downloading_direct,
            downloading_wire,
            "downloading",
        ),
        ("corrupt", corrupt_direct, corrupt_wire, "missing"),
        ("modified", modified_direct, modified_wire, "pending"),
    ] {
        assert!(!direct, "strict setup accepted {label} assets");
        assert_eq!(wire["modelId"], spec.id);
        assert_eq!(wire["ready"], false, "handler accepted {label} assets");
        assert_eq!(
            wire["status"],
            if engine_available {
                status
            } else {
                "unavailable"
            }
        );
    }
}

#[test]
fn setup_readiness_reports_unavailable_engine_instead_of_missing_download() {
    let (store, dir) = temp_store("setup-engine-unavailable");
    fs::create_dir_all(&dir).unwrap();
    let state = crate::stt::SttState::new(
        store,
        Arc::new(crate::capture::pcm_store::PcmBufferStore::new()),
    );
    let app = tauri::test::mock_builder()
        .manage(state)
        .build(crate::app_context())
        .unwrap();
    // Unknown engine is always unavailable, including builds with Whisper.
    let wire = readiness(&app, "unknown-engine");
    fs::remove_dir_all(dir).unwrap();
    assert_eq!(wire["ready"], false);
    assert_eq!(wire["status"], "unavailable");
}

#[test]
fn setup_readiness_answers_a_known_verdict_without_waiting_on_the_hashing_lock() {
    let (store, dir) = temp_store("setup-known-verdict");
    fs::create_dir_all(&dir).unwrap();
    let spec = crate::stt::catalog::find("whisper-base.en").unwrap();
    let path = store.model_path(spec);
    // No model download: a fixture recorded as a verified download.
    fs::write(&path, b"verified fixture").unwrap();
    store.mark_verified(spec, &path);
    let store = Arc::new(store);
    // Startup hashing of another model holds the shared lock.
    let hashing = store.hashing.lock().unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    let probe = store.clone();
    std::thread::spawn(move || {
        let _ = send.send(probe.setup_verified(spec.id));
    });
    let known = receive.recv_timeout(std::time::Duration::from_secs(5));
    drop(hashing);
    // A changed file is no longer vouched for: it waits for the pinned hash,
    // which rejects these bytes.
    fs::write(&path, b"changed after verification").unwrap();
    let changed = store.setup_verified(spec.id);
    fs::remove_dir_all(dir).unwrap();
    assert_eq!(known, Ok(true), "known verdict waited on the hashing lock");
    assert!(!changed, "strict setup accepted a changed file");
}

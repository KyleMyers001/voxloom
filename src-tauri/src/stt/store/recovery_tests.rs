//! BUS-35: unreadable model files. Open failures are re-checked on each use
//! and recover (with one background re-check); read failures are kept.

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::existing::{
    classify, write_marker, Verdict, DAMAGED_MESSAGE, READ_FAILED_MESSAGE, UNREADABLE_MESSAGE,
};
use super::tests::{spec_for, temp_store};
use super::ModelStore;
use crate::model_fetch::FetchError;
use crate::stt::catalog;

/// Count `stt:models-changed` notifications.
fn count_refreshes(store: &ModelStore) -> Arc<AtomicUsize> {
    let refreshes = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&refreshes);
    store.set_on_models_changed(Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    }));
    refreshes
}

/// chmod `path`; false if permissions can't block opening it (root).
#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    mode != 0 || fs::File::open(path).is_err()
}

fn assert_refused(store: &ModelStore, id: &str, reason: &str, message: &str) {
    let info = store.status(id).unwrap();
    assert_eq!(info.status, "failed");
    assert_eq!(info.failure_reason.as_deref(), Some(reason));
    let err = store.resolved_path(id).unwrap_err();
    assert_eq!(err.code, "model-missing");
    assert_eq!(err.message, message);
}

#[test]
fn io_errors_split_into_open_and_read_failures() {
    let io = || Err(FetchError::Io("read: Input/output error".into()));
    assert_eq!(classify(io(), true), Verdict::ReadFailed);
    assert_eq!(classify(io(), false), Verdict::OpenFailed);
    let bad = Err(FetchError::SizeMismatch {
        expected: 2,
        actual: 1,
    });
    assert_eq!(classify(bad, true), Verdict::Corrupt);
    assert_eq!(classify(Ok(()), true), Verdict::Verified);
}

#[test]
fn read_failed_verdict_stays_failed_while_the_file_opens() {
    let (store, dir) = temp_store("read-failed");
    fs::create_dir_all(&dir).unwrap();
    let spec = catalog::find("whisper-base.en").unwrap();
    fs::write(store.model_path(spec), b"x").unwrap();
    let refreshes = count_refreshes(&store);
    store.set_verdict(spec, Verdict::ReadFailed);
    for _ in 0..3 {
        assert_refused(&store, spec.id, "read-failed", READ_FAILED_MESSAGE);
    }
    assert_eq!(store.known_verdict(spec), Some(Verdict::ReadFailed));
    assert_eq!(refreshes.load(Ordering::SeqCst), 0, "nothing cleared");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn cleared_open_failure_falls_back_to_a_matching_marker() {
    let body = vec![0x31u8; 1024];
    let spec = spec_for("whisper-tiny.en", &body);
    let (store, dir) = temp_store("open-failed-marker");
    fs::create_dir_all(&dir).unwrap();
    fs::write(store.model_path(&spec), &body).unwrap();
    write_marker(&spec, &store.model_path(&spec));
    store.set_verdict(&spec, Verdict::OpenFailed);
    assert_eq!(store.current_verdict(&spec), Some(Verdict::Verified));
    assert_eq!(store.known_verdict(&spec), Some(Verdict::Verified));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn copy_matches_the_frontend() {
    // TS literals escape the apostrophe.
    let ts = |s: &str| s.replace('\'', "\\'");
    let models = include_str!("../../../../src/services/stt/useSttModels.ts");
    assert!(models.contains(&ts(UNREADABLE_MESSAGE)), "MODEL_UNREADABLE");
    let dogfood = include_str!("../../../../src/services/stt/dogfoodModel.ts");
    assert!(
        dogfood.contains(&ts(DAMAGED_MESSAGE)),
        "MODEL_DAMAGED_MESSAGE"
    );
    assert!(
        dogfood.contains(&ts(READ_FAILED_MESSAGE)),
        "MODEL_READ_FAILED_MESSAGE"
    );
}

#[cfg(unix)]
#[test]
fn marked_file_at_chmod_000_reads_unreadable_without_caching() {
    let body = vec![0x41u8; 1024];
    let spec = spec_for("whisper-tiny.en", &body);
    let (store, dir) = temp_store("marked-000");
    fs::create_dir_all(&dir).unwrap();
    let path = store.model_path(&spec);
    fs::write(&path, &body).unwrap();
    assert_eq!(store.verify_existing(&spec), Some(Verdict::Verified));
    let refreshes = count_refreshes(&store);
    if !set_mode(&path, 0o000) {
        eprintln!("skipping chmod 000 test: running as root");
        let _ = fs::remove_dir_all(&dir);
        return;
    }
    // Same store (cached Verified) and a relaunch (marker only) both see it.
    let fresh = ModelStore::new(dir.clone());
    for s in [&store, &fresh] {
        assert_eq!(s.current_verdict(&spec), Some(Verdict::OpenFailed));
        assert_eq!(
            s.known_verdict(&spec),
            Some(Verdict::Verified),
            "not cached"
        );
    }
    assert_refused(&store, spec.id, "unreadable", UNREADABLE_MESSAGE);
    set_mode(&path, 0o644);
    assert_eq!(store.current_verdict(&spec), Some(Verdict::Verified));
    assert_eq!(store.status(spec.id).unwrap().status, "available");
    assert_eq!(refreshes.load(Ordering::SeqCst), 0, "no cache, no event");
    let _ = fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn recovered_file_gets_one_background_check_and_shows_damaged() {
    let (store, dir) = temp_store("recover-reverify");
    fs::create_dir_all(&dir).unwrap();
    let spec = catalog::find("whisper-base.en").unwrap();
    let path = store.model_path(spec);
    fs::write(&path, b"not the pinned bytes").unwrap();
    if !set_mode(&path, 0o000) {
        eprintln!("skipping re-verify test: running as root");
        let _ = fs::remove_dir_all(&dir);
        return;
    }
    let store = Arc::new(store);
    let refreshes = count_refreshes(&store);
    let counter = Arc::clone(&refreshes);
    store
        .spawn_verify_existing(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        })
        .join()
        .unwrap();
    assert_eq!(store.known_verdict(spec), Some(Verdict::OpenFailed));
    assert_refused(&store, spec.id, "unreadable", UNREADABLE_MESSAGE);
    assert_eq!(refreshes.load(Ordering::SeqCst), 1, "startup verdict");

    // Hold the hashing lock: the re-check waits, and dictation must not.
    let hashing = store.hashing.lock().unwrap();
    set_mode(&path, 0o644);
    assert_eq!(store.resolved_path(spec.id).unwrap(), path);
    for _ in 0..3 {
        assert_eq!(store.status(spec.id).unwrap().status, "available");
    }
    assert_eq!(refreshes.load(Ordering::SeqCst), 2, "one clear");
    store.queue_reverify(spec.id); // already pending: not queued again
    assert_eq!(store.reverifying.lock().unwrap().len(), 1, "one re-check");
    drop(hashing);

    let deadline = Instant::now() + Duration::from_secs(10);
    while !store.reverifying.lock().unwrap().is_empty() {
        assert!(Instant::now() < deadline, "re-check never finished");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(store.known_verdict(spec), Some(Verdict::Corrupt));
    assert_refused(&store, spec.id, "damaged", DAMAGED_MESSAGE);
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(
        refreshes.load(Ordering::SeqCst),
        3,
        "re-check verdict, once"
    );
    let _ = fs::remove_dir_all(&dir);
}
#[cfg(unix)]
#[test]
fn open_failed_file_is_refused_until_it_opens_again() {
    let (store, dir) = temp_store("unreadable");
    fs::create_dir_all(&dir).unwrap();
    let spec = catalog::find("whisper-base.en").unwrap();
    let path = store.model_path(spec);
    fs::write(&path, b"x").unwrap();
    if !set_mode(&path, 0o000) {
        eprintln!("skipping open-failed test: running as root");
        let _ = fs::remove_dir_all(&dir);
        return;
    }
    let refreshes = count_refreshes(&store);

    assert_eq!(store.verify_existing(spec), Some(Verdict::OpenFailed));
    // Still unreadable: refused, verdict kept, row failed (unreadable) with Retry.
    assert_refused(&store, spec.id, "unreadable", UNREADABLE_MESSAGE);
    assert_eq!(store.known_verdict(spec), Some(Verdict::OpenFailed));
    assert_eq!(refreshes.load(Ordering::SeqCst), 0);
    assert!(path.is_file(), "never deleted");

    // Readable again: the next resolve re-opens it (no hash), clears the
    // verdict to not-yet-checked, allows transcription and asks for a re-list.
    // (No startup pass ran on this store, so no background re-check.)
    set_mode(&path, 0o644);
    assert_eq!(store.resolved_path(spec.id).unwrap(), path);
    assert_eq!(store.known_verdict(spec), None, "cleared, not verified");
    let info = store.status(spec.id).unwrap();
    assert_eq!(info.status, "available");
    assert_eq!(info.failure_reason, None);
    assert_eq!(
        refreshes.load(Ordering::SeqCst),
        1,
        "one refresh per recovery"
    );
    let _ = fs::remove_dir_all(&dir);
}

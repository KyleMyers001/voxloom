//! BUS-35: verification of model files already on disk (hash once, persist
//! a marker, refuse a damaged file) layered on the BUS-16 `model_fetch`
//! download path, plus a late-cancel regression test.

use std::fs;

use super::existing::{marker_path, Verdict};
use super::tests::{serve_bytes, spec_for, temp_store, test_agent};
use crate::stt::catalog;

#[test]
fn cancel_after_rename_keeps_verified_model() {
    let body = vec![0x44u8; 16 * 1024];
    let spec = spec_for("whisper-tiny.en", &body);
    let (store, dir) = temp_store("cancel-after-rename");
    let url = serve_bytes(body.clone(), None);
    let dest = store.model_path(&spec);
    let result = store.download_spec_with_sink(&test_agent(), &spec, &url, |p| {
        if p.ratio >= 1.0 {
            // The completion event fires after the rename; cancel lands late.
            assert!(dest.is_file());
            store.cancel(spec.id).unwrap();
        }
    });
    assert!(
        result.is_ok(),
        "late cancel must not fail a finished download"
    );
    assert_eq!(fs::read(&dest).unwrap(), body, "verified model is kept");
    assert_eq!(store.status(spec.id).unwrap().status, "available");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn existing_file_is_hashed_once_then_trusted_by_marker() {
    let body = vec![0x55u8; 20 * 1024];
    let spec = spec_for("whisper-tiny.en", &body);
    let (store, dir) = temp_store("existing-ok");
    fs::create_dir_all(&dir).unwrap();
    let path = store.model_path(&spec);
    fs::write(&path, &body).unwrap();
    assert_eq!(
        store.known_verdict(&spec),
        None,
        "unverified before hashing"
    );

    assert_eq!(store.verify_existing(&spec), Some(Verdict::Verified));
    let marker = fs::read_to_string(marker_path(&path)).unwrap();
    assert!(marker.starts_with(spec.sha256), "{marker}");

    // A fresh store (next launch) trusts the marker without hashing. Proof:
    // same-length different bytes, which only a re-hash would catch.
    fs::write(&path, vec![0x66u8; body.len()]).unwrap();
    let fresh = super::ModelStore::new(dir.clone());
    assert_eq!(
        fresh.known_verdict(&spec),
        Some(Verdict::Verified),
        "no re-hash once marked"
    );

    // A length change invalidates the marker.
    fs::write(&path, b"short").unwrap();
    let fresh = super::ModelStore::new(dir.clone());
    assert_eq!(fresh.known_verdict(&spec), None);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn existing_file_with_wrong_size_reports_failed_and_is_not_deleted() {
    let (store, dir) = temp_store("existing-bad-size");
    fs::create_dir_all(&dir).unwrap();
    // Real catalog pin; these bytes are not the model.
    let spec = catalog::find("whisper-tiny.en").unwrap();
    let path = store.model_path(spec);
    fs::write(&path, b"not the model").unwrap();

    assert_eq!(store.verify_existing(spec), Some(Verdict::Corrupt));
    assert!(path.is_file(), "never deleted silently");
    assert!(!marker_path(&path).exists());
    assert_eq!(
        store.status(spec.id).unwrap().status,
        "failed",
        "UI offers Retry"
    );

    let err = store.resolved_path(spec.id).unwrap_err();
    assert_eq!(err.code, "model-missing");
    assert!(err.message.contains("damaged"), "{}", err.message);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn existing_file_with_right_size_but_wrong_hash_is_corrupt() {
    let body = vec![0x12u8; 8 * 1024];
    let spec = spec_for("whisper-base.en", &body);
    let (store, dir) = temp_store("existing-bad-hash");
    fs::create_dir_all(&dir).unwrap();
    let path = store.model_path(&spec);
    fs::write(&path, vec![0x13u8; body.len()]).unwrap();

    assert_eq!(store.verify_existing(&spec), Some(Verdict::Corrupt));
    assert!(path.is_file());
    assert!(!marker_path(&path).exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn model_still_being_checked_stays_usable_for_transcription() {
    let (store, dir) = temp_store("existing-pending");
    fs::create_dir_all(&dir).unwrap();
    let spec = catalog::find("whisper-base.en").unwrap();
    fs::write(store.model_path(spec), b"not yet checked").unwrap();
    let store = std::sync::Arc::new(store);

    // Simulate the startup hash in progress: it holds the hashing lock.
    let hashing = store.hashing.lock().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let worker = std::sync::Arc::clone(&store);
    std::thread::spawn(move || {
        let _ = tx.send(worker.resolved_path(spec.id).map(|_| ()));
    });
    let resolved = rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .expect("resolved_path must not wait for the background hash");
    drop(hashing);

    assert!(resolved.is_ok(), "unchecked model is usable: {resolved:?}");
    assert_eq!(store.status(spec.id).unwrap().status, "available");
    assert_eq!(
        store.known_verdict(spec),
        None,
        "resolved_path never hashes"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn model_found_damaged_by_the_check_is_refused() {
    let (store, dir) = temp_store("existing-refused");
    fs::create_dir_all(&dir).unwrap();
    let spec = catalog::find("whisper-base.en").unwrap();
    fs::write(store.model_path(spec), b"tampered").unwrap();
    assert_eq!(store.verify_existing(spec), Some(Verdict::Corrupt));
    let err = store.resolved_path(spec.id).unwrap_err();
    assert_eq!(err.code, "model-missing");
    assert!(err.message.contains("damaged"), "{}", err.message);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn download_writes_marker_and_replaces_a_corrupt_verdict() {
    let body = vec![0x77u8; 8 * 1024];
    let spec = spec_for("whisper-base.en", &body);
    let (store, dir) = temp_store("download-marker");
    fs::create_dir_all(&dir).unwrap();
    fs::write(store.model_path(&spec), b"old damaged file").unwrap();
    assert_eq!(store.verify_existing(&spec), Some(Verdict::Corrupt));

    let url = serve_bytes(body.clone(), None);
    store
        .download_spec_with_sink(&test_agent(), &spec, &url, |_| {})
        .unwrap();
    assert_eq!(fs::read(store.model_path(&spec)).unwrap(), body);
    assert!(marker_path(&store.model_path(&spec)).is_file());
    assert_eq!(store.known_verdict(&spec), Some(Verdict::Verified));
    assert_eq!(store.status(spec.id).unwrap().status, "available");
    let _ = fs::remove_dir_all(&dir);
}

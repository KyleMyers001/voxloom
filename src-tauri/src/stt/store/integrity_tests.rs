//! BUS-35: verification of model files already on disk (hash once, persist
//! a marker, refuse a damaged file) layered on the BUS-16 `model_fetch`
//! download path, plus a late-cancel regression test.

use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use super::existing::{marker_path, Verdict};
use super::tests::{serve_bytes, spec_for, temp_store, test_agent};
use crate::stt::catalog;

fn set_mtime(path: &std::path::Path, at: SystemTime) {
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(at)
        .unwrap();
}

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
    // same-length different bytes with the original mtime restored.
    let mtime = fs::metadata(&path).unwrap().modified().unwrap();
    fs::write(&path, vec![0x66u8; body.len()]).unwrap();
    set_mtime(&path, mtime);
    let fresh = super::ModelStore::new(dir.clone());
    assert_eq!(
        fresh.known_verdict(&spec),
        Some(Verdict::Verified),
        "no re-hash once marked"
    );

    // A file replaced at the same size (new mtime) is re-hashed.
    set_mtime(&path, mtime + Duration::from_secs(5));
    let fresh = super::ModelStore::new(dir.clone());
    assert_eq!(fresh.known_verdict(&spec), None);
    assert_eq!(fresh.verify_existing(&spec), Some(Verdict::Corrupt));

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

#[test]
fn stale_pin_marker_is_rehashed() {
    // A marker from another pin (same length and mtime) is ignored.
    let body = vec![0x88u8; 4 * 1024];
    let spec = spec_for("whisper-tiny.en", &body);
    let (store, dir) = temp_store("stale-pin");
    fs::create_dir_all(&dir).unwrap();
    let path = store.model_path(&spec);
    fs::write(&path, &body).unwrap();
    assert_eq!(store.verify_existing(&spec), Some(Verdict::Verified));
    let marker = fs::read_to_string(marker_path(&path)).unwrap();
    let stale = marker.replacen(spec.sha256, &"0".repeat(64), 1);
    assert_ne!(stale, marker);
    fs::write(marker_path(&path), stale).unwrap();

    let fresh = super::ModelStore::new(dir.clone());
    assert_eq!(fresh.known_verdict(&spec), None, "stale pin is not trusted");
    assert_eq!(fresh.verify_existing(&spec), Some(Verdict::Verified));
    assert_eq!(fs::read_to_string(marker_path(&path)).unwrap(), marker);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn legacy_two_field_marker_is_rehashed() {
    let body = vec![0x99u8; 4 * 1024];
    let spec = spec_for("whisper-tiny.en", &body);
    let (store, dir) = temp_store("legacy-marker");
    fs::create_dir_all(&dir).unwrap();
    let path = store.model_path(&spec);
    fs::write(&path, &body).unwrap();
    fs::write(
        marker_path(&path),
        format!("{} {}\n", spec.sha256, body.len()),
    )
    .unwrap();
    assert_eq!(store.known_verdict(&spec), None);
    assert_eq!(store.verify_existing(&spec), Some(Verdict::Verified));
    let marker = fs::read_to_string(marker_path(&path)).unwrap();
    assert_eq!(marker.split_whitespace().count(), 3, "{marker}");
    let _ = fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn unreadable_file_is_failed_with_retry_and_refused() {
    use std::os::unix::fs::PermissionsExt;
    let (store, dir) = temp_store("unreadable");
    fs::create_dir_all(&dir).unwrap();
    let spec = catalog::find("whisper-base.en").unwrap();
    let path = store.model_path(spec);
    fs::write(&path, b"x").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
    if fs::File::open(&path).is_ok() {
        // Running as root: permissions can't make the file unreadable.
        eprintln!("skipping unreadable_file test: running as root");
        let _ = fs::remove_dir_all(&dir);
        return;
    }
    assert_eq!(store.verify_existing(spec), Some(Verdict::Unreadable));
    // Cached: the row offers Retry instead of staying "available".
    assert_eq!(store.known_verdict(spec), Some(Verdict::Unreadable));
    assert_eq!(store.status(spec.id).unwrap().status, "failed");
    let err = store.resolved_path(spec.id).unwrap_err();
    assert_eq!(err.code, "model-missing");
    assert_eq!(
        err.message,
        "Couldn't open the model file. Download it again in Settings."
    );
    assert!(path.is_file(), "never deleted");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn startup_pass_checks_every_present_file_and_reports_each_verdict() {
    let good = vec![0x21u8; 4 * 1024];
    let (store, dir) = temp_store("startup-pass");
    fs::create_dir_all(&dir).unwrap();
    // Real pins: one damaged file, one absent model.
    let tiny = catalog::find("whisper-tiny.en").unwrap();
    let base = catalog::find("whisper-base.en").unwrap();
    fs::write(store.model_path(tiny), &good).unwrap();
    let store = Arc::new(store);
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);

    store
        .spawn_verify_existing(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        })
        .join()
        .unwrap();

    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "one present file, one verdict"
    );
    assert_eq!(store.known_verdict(tiny), Some(Verdict::Corrupt));
    assert_eq!(store.status(tiny.id).unwrap().status, "failed");
    assert_eq!(store.status(base.id).unwrap().status, "missing");

    // A second pass has nothing left to check.
    let again = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&again);
    store
        .spawn_verify_existing(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        })
        .join()
        .unwrap();
    assert_eq!(again.load(Ordering::SeqCst), 0);
    let _ = fs::remove_dir_all(&dir);
}

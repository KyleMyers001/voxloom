//! BUS-35 acceptance tests: checksum mismatch, truncated stream and
//! cancel-after-rename against a local HTTP server.

use std::fs;

use super::tests::{serve_bytes, serve_truncated, spec_for_body, temp_store};
use crate::stt::catalog;

#[test]
fn checksum_mismatch_deletes_file_and_reports_failure() {
    let (store, dir) = temp_store("sha-mismatch");
    // Real catalog pin; the served bytes are not the real model.
    let spec = catalog::find("whisper-tiny.en").unwrap();
    let url = serve_bytes(vec![0x11u8; 32 * 1024], None);
    let mut final_ratio = 0.0;
    let err = store
        .download_spec_with_sink(spec, &url, |p| final_ratio = p.ratio)
        .unwrap_err();
    assert_eq!(err.code, "download-corrupted");
    assert_eq!(err.message, "Download was damaged. Nothing was saved.");
    assert!(final_ratio < 1.0, "never report completion for a bad file");
    assert!(
        !store.model_path(spec).exists(),
        "bad file is not finalized"
    );
    assert!(!store
        .model_path(spec)
        .with_extension("bin.partial")
        .exists());
    assert_eq!(store.status(spec.id).unwrap().status, "missing");
    assert!(store.inflight.lock().unwrap().is_none());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn matching_checksum_finalizes_model() {
    let body = vec![0x22u8; 40 * 1024];
    let spec = spec_for_body("whisper-base.en", &body);
    let (store, dir) = temp_store("sha-match");
    let url = serve_bytes(body.clone(), None);
    store.download_spec_with_sink(&spec, &url, |_| {}).unwrap();
    assert_eq!(fs::read(store.model_path(&spec)).unwrap(), body);
    assert_eq!(store.status(spec.id).unwrap().status, "available");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn truncated_stream_fails_even_when_prefix_hash_would_match() {
    // Pin the hash of exactly what is sent, so only the Content-Length check
    // can catch the early close.
    let sent = vec![0x33u8; 300 * 1024];
    let spec = spec_for_body("whisper-base.en", &sent);
    let (store, dir) = temp_store("truncated");
    let url = serve_truncated(sent, 1024 * 1024);
    let err = store
        .download_spec_with_sink(&spec, &url, |_| {})
        .unwrap_err();
    assert_eq!(err.code, "download-failed");
    assert!(!store.model_path(&spec).exists());
    assert!(!store
        .model_path(&spec)
        .with_extension("bin.partial")
        .exists());
    assert_eq!(store.status(spec.id).unwrap().status, "missing");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn cancel_after_rename_keeps_verified_model() {
    let body = vec![0x44u8; 16 * 1024];
    let spec = spec_for_body("whisper-tiny.en", &body);
    let (store, dir) = temp_store("cancel-after-rename");
    let url = serve_bytes(body.clone(), None);
    let dest = store.model_path(&spec);
    let result = store.download_spec_with_sink(&spec, &url, |p| {
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

// --- Existing files on disk (Codex P1): hash once, persist a marker. ---

use super::existing::{marker_path, Verdict};
use std::time::{Duration, SystemTime};

fn set_mtime(path: &std::path::Path, at: SystemTime) {
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(at)
        .unwrap();
}

#[test]
fn existing_file_is_hashed_once_then_trusted_by_marker() {
    let body = vec![0x55u8; 20 * 1024];
    let spec = spec_for_body("whisper-tiny.en", &body);
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

    // BUS-77: a same-length change with a new mtime invalidates the marker.
    set_mtime(&path, mtime + Duration::from_secs(5));
    let fresh = super::ModelStore::new(dir.clone());
    assert_eq!(fresh.known_verdict(&spec), None);

    // A length change invalidates the marker.
    fs::write(&path, b"short").unwrap();
    let fresh = super::ModelStore::new(dir.clone());
    assert_eq!(fresh.known_verdict(&spec), None);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn existing_file_mismatch_reports_failed_and_is_not_deleted() {
    let (store, dir) = temp_store("existing-bad");
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
fn resolved_path_verifies_unmarked_file_before_use() {
    let (store, dir) = temp_store("existing-resolve");
    fs::create_dir_all(&dir).unwrap();
    let spec = catalog::find("whisper-base.en").unwrap();
    fs::write(store.model_path(spec), b"tampered").unwrap();
    // Status is optimistic until the background hash finishes...
    assert_eq!(store.status(spec.id).unwrap().status, "available");
    // ...but transcription hashes first and refuses the file.
    assert!(store.resolved_path(spec.id).is_err());
    assert_eq!(store.status(spec.id).unwrap().status, "failed");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn download_writes_marker() {
    let body = vec![0x77u8; 8 * 1024];
    let spec = spec_for_body("whisper-base.en", &body);
    let (store, dir) = temp_store("download-marker");
    let url = serve_bytes(body, None);
    store.download_spec_with_sink(&spec, &url, |_| {}).unwrap();
    assert!(marker_path(&store.model_path(&spec)).is_file());
    assert_eq!(store.known_verdict(&spec), Some(Verdict::Verified));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn stale_pin_marker_is_not_trusted() {
    // BUS-77: a marker from an older pin (same length and mtime) is ignored.
    let body = vec![0x88u8; 4 * 1024];
    let spec = spec_for_body("whisper-tiny.en", &body);
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
    assert_eq!(fresh.known_verdict(&spec), None);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn legacy_two_field_marker_is_rehashed() {
    let body = vec![0x99u8; 4 * 1024];
    let spec = spec_for_body("whisper-tiny.en", &body);
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
fn unreadable_file_is_not_reported_damaged() {
    use std::os::unix::fs::PermissionsExt;
    let (store, dir) = temp_store("unreadable");
    fs::create_dir_all(&dir).unwrap();
    let spec = catalog::find("whisper-base.en").unwrap();
    let path = store.model_path(spec);
    fs::write(&path, b"x").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
    if fs::File::open(&path).is_ok() {
        // Running as root: permissions can't make the file unreadable.
        let _ = fs::remove_dir_all(&dir);
        return;
    }
    let err = store.resolved_path(spec.id).unwrap_err();
    assert!(
        err.message.contains("Couldn't open the model file"),
        "{}",
        err.message
    );
    assert_ne!(store.status(spec.id).unwrap().status, "failed");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    let _ = fs::remove_dir_all(&dir);
}

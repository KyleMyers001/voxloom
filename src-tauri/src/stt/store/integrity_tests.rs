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
    assert_eq!(err.code, "download-failed");
    assert!(err.message.contains("Checksum mismatch"), "{}", err.message);
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

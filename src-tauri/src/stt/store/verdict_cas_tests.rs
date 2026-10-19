//! Codex P2 4317892888: a failed verdict from a hash is cached only if the
//! file still has the fingerprint the hash saw, checked under the verdicts
//! lock, so a download that landed after the hash keeps its `Verified`.

use std::fs;

use super::existing::{fingerprint, Verdict};
use super::tests::{spec_for, temp_store};

#[test]
fn stale_failure_does_not_replace_a_downloads_verified() {
    let old = vec![0x01u8; 2 * 1024];
    let new = vec![0x02u8; 3 * 1024];
    let spec = spec_for("whisper-tiny.en", &new);
    let (store, dir) = temp_store("cas-stale");
    fs::create_dir_all(&dir).unwrap();
    let path = store.model_path(&spec);
    fs::write(&path, &old).unwrap();
    let hashed_at = fingerprint(&path).unwrap();

    // After the post-hash check, a Retry download renames verified bytes
    // into place and records them before the stale verdict is cached.
    fs::write(&path, &new).unwrap();
    store.mark_verified(&spec, &path);
    let cached = store.set_verdict_if_unchanged(&spec, &path, hashed_at, Verdict::Corrupt);
    assert!(!cached, "stale verdict is dropped");
    assert_eq!(store.known_verdict(&spec), Some(Verdict::Verified));
    assert_eq!(store.status(spec.id).unwrap().status, "available");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn failure_for_an_unchanged_file_is_cached() {
    let spec = spec_for("whisper-tiny.en", b"pinned");
    let (store, dir) = temp_store("cas-same");
    fs::create_dir_all(&dir).unwrap();
    let path = store.model_path(&spec);
    fs::write(&path, b"damaged").unwrap();
    let hashed_at = fingerprint(&path).unwrap();

    let cached = store.set_verdict_if_unchanged(&spec, &path, hashed_at, Verdict::ReadFailed);
    assert!(cached);
    assert_eq!(store.known_verdict(&spec), Some(Verdict::ReadFailed));
    let _ = fs::remove_dir_all(&dir);
}

//! BUS-85: within a session a `Verified` file is trusted by the length and
//! mtime its hash saw (not the marker), re-checked once when the file
//! changes, and a hash of a file that changed mid-hash is dropped.

use std::cell::Cell;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use super::existing::{marker_path, write_marker, Verdict};
use super::tests::{spec_for, temp_store};
use super::ModelStore;
use crate::model_fetch::FetchError;
use crate::stt::catalog::{self, ModelSpec};

fn set_mtime(path: &Path, at: SystemTime) {
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(at)
        .unwrap();
}

/// Count `stt:models-changed` notifications.
fn count_refreshes(store: &ModelStore) -> Arc<AtomicUsize> {
    let refreshes = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&refreshes);
    store.set_on_models_changed(Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    }));
    refreshes
}

/// A store whose startup pass ran (so re-checks can queue) and whose model
/// directory exists, with nothing at `spec`'s path yet.
fn started_store(label: &str) -> (Arc<ModelStore>, PathBuf) {
    let (store, dir) = temp_store(label);
    fs::create_dir_all(&dir).unwrap();
    let store = Arc::new(store);
    store.spawn_verify_existing(|| {}).join().unwrap();
    (store, dir)
}

/// A started store with a file at `spec`'s path, marked verified and cached
/// as `Verified`. Real pin, so a re-hash of the file finds it damaged.
fn marked_store(label: &str, spec: &'static ModelSpec) -> (Arc<ModelStore>, PathBuf) {
    let (store, dir) = started_store(label);
    let path = store.model_path(spec);
    fs::write(&path, b"good").unwrap();
    write_marker(spec, &path);
    assert_eq!(store.known_verdict(spec), Some(Verdict::Verified));
    (store, dir)
}

fn wait_until(done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < deadline, "re-check never finished");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn file_rewritten_mid_session_drops_verified_and_is_rechecked() {
    let spec = catalog::find("whisper-base.en").unwrap();
    let (store, dir) = marked_store("mid-session", spec);
    let refreshes = count_refreshes(&store);
    let path = store.model_path(spec);

    // Hold the hashing lock: dictation must not wait on the re-check.
    let hashing = store.hashing.lock().unwrap();
    fs::write(&path, b"damaged mid-session").unwrap();
    assert_eq!(store.resolved_path(spec.id).unwrap(), path);
    assert_eq!(store.known_verdict(spec), None, "cached Verified dropped");
    assert_eq!(store.reverifying.lock().unwrap().len(), 1, "one re-check");
    drop(hashing);

    // The re-check notifies after it leaves `reverifying`: wait on both.
    wait_until(|| {
        refreshes.load(Ordering::SeqCst) > 0 && store.reverifying.lock().unwrap().is_empty()
    });
    assert_eq!(store.known_verdict(spec), Some(Verdict::Corrupt));
    let info = store.status(spec.id).unwrap();
    assert_eq!(info.status, "failed", "no longer available");
    assert_eq!(info.failure_reason.as_deref(), Some("damaged"));
    assert!(store.resolved_path(spec.id).is_err());
    assert!(
        store.reverifying.lock().unwrap().is_empty(),
        "a cached Corrupt is not re-checked"
    );
    assert_eq!(refreshes.load(Ordering::SeqCst), 1, "re-list once");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn untouched_verified_file_is_not_rehashed() {
    let spec = catalog::find("whisper-base.en").unwrap();
    let (store, dir) = marked_store("untouched", spec);
    let refreshes = count_refreshes(&store);
    let path = store.model_path(spec);

    // Proof of no hash: these bytes fail the real pin, but length and mtime
    // are unchanged, so only a re-hash would notice them.
    let mtime = fs::metadata(&path).unwrap().modified().unwrap();
    fs::write(&path, b"bad!").unwrap();
    set_mtime(&path, mtime);
    for _ in 0..3 {
        assert_eq!(store.resolved_path(spec.id).unwrap(), path);
        assert_eq!(store.status(spec.id).unwrap().status, "available");
    }
    assert!(
        store.reverifying.lock().unwrap().is_empty(),
        "nothing queued"
    );
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(store.known_verdict(spec), Some(Verdict::Verified));
    assert_eq!(refreshes.load(Ordering::SeqCst), 0);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn unsaved_marker_never_causes_a_rehash() {
    // Codex P1 4317736110: a marker that can't be written must not make
    // every status / resolve call queue another full hash.
    let body = vec![0x5au8; 4 * 1024];
    let spec = spec_for("whisper-tiny.en", &body);
    let (store, dir) = started_store("unsaved-marker");
    let path = store.model_path(&spec);
    fs::write(&path, &body).unwrap();
    // A directory where the marker goes: the write fails, even as root.
    fs::create_dir(marker_path(&path)).unwrap();
    assert_eq!(store.verify_existing(&spec), Some(Verdict::Verified));
    assert!(!marker_path(&path).is_file(), "marker was not saved");
    let refreshes = count_refreshes(&store);

    // Status and resolve use the real pin: any re-hash would find these
    // bytes damaged, so staying Verified proves none ran.
    for _ in 0..20 {
        assert_eq!(store.resolved_path(spec.id).unwrap(), path);
        assert_eq!(store.status(spec.id).unwrap().status, "available");
        assert!(store.reverifying.lock().unwrap().is_empty(), "no re-hash");
    }
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(store.known_verdict(&spec), Some(Verdict::Verified));
    assert_eq!(refreshes.load(Ordering::SeqCst), 0, "no re-list loop");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn recheck_landing_on_the_shown_verdict_does_not_re_list() {
    let spec = catalog::find("whisper-base.en").unwrap();
    let (store, dir) = marked_store("recheck-same", spec);
    let refreshes = count_refreshes(&store);
    let path = store.model_path(spec);

    let hashing = store.hashing.lock().unwrap();
    fs::write(&path, b"replaced").unwrap();
    assert_eq!(store.status(spec.id).unwrap().status, "available");
    assert_eq!(store.reverifying.lock().unwrap().len(), 1, "one re-check");
    // A download finishes before the re-check runs: still Verified.
    store.mark_verified(spec, &path);
    drop(hashing);

    wait_until(|| store.reverifying.lock().unwrap().is_empty());
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(store.known_verdict(spec), Some(Verdict::Verified));
    assert_eq!(refreshes.load(Ordering::SeqCst), 0, "row did not change");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn download_landing_mid_hash_keeps_its_verified() {
    let old = vec![0x01u8; 2 * 1024];
    let new = vec![0x02u8; 3 * 1024];
    let spec = spec_for("whisper-tiny.en", &new);
    let (store, dir) = temp_store("download-mid-hash");
    fs::create_dir_all(&dir).unwrap();
    let path = store.model_path(&spec);
    fs::write(&path, &old).unwrap();

    let hashes = Cell::new(0);
    let verdict = store.verify_existing_with(&spec, |path| {
        hashes.set(hashes.get() + 1);
        // The download renames verified bytes into place and records them.
        fs::write(path, &new).unwrap();
        store.mark_verified(&spec, path);
        Err(FetchError::SizeMismatch {
            expected: new.len() as u64,
            actual: old.len() as u64,
        })
    });
    assert_eq!(verdict, Some(Verdict::Verified), "old hash is dropped");
    assert_eq!(hashes.get(), 1, "the download's verdict is reused");
    assert_eq!(store.known_verdict(&spec), Some(Verdict::Verified));
    let marker = fs::read_to_string(marker_path(&path)).unwrap();
    assert!(marker.starts_with(spec.sha256), "{marker}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn file_changed_mid_hash_is_hashed_again() {
    let good = vec![0x03u8; 2 * 1024];
    let spec = spec_for("whisper-tiny.en", &good);
    let (store, dir) = temp_store("changed-mid-hash");
    fs::create_dir_all(&dir).unwrap();
    let path = store.model_path(&spec);
    fs::write(&path, &good).unwrap();

    let hashes = Cell::new(0);
    let verdict = store.verify_existing_with(&spec, |path| {
        hashes.set(hashes.get() + 1);
        if hashes.get() == 1 {
            // The good bytes hashed fine, then were replaced mid-hash.
            fs::write(path, b"replaced while hashing").unwrap();
            return Ok(());
        }
        crate::model_fetch::verify_file(path, &spec.artifact())
    });
    assert_eq!(
        verdict,
        Some(Verdict::Corrupt),
        "verdict is for the new bytes"
    );
    assert_eq!(hashes.get(), 2);
    assert!(!marker_path(&path).exists(), "no marker for the old bytes");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn file_that_keeps_changing_stays_unchecked() {
    let spec = spec_for("whisper-tiny.en", b"pinned");
    let (store, dir) = temp_store("keeps-changing");
    fs::create_dir_all(&dir).unwrap();
    let path = store.model_path(&spec);
    fs::write(&path, b"x").unwrap();

    let hashes = Cell::new(0);
    let verdict = store.verify_existing_with(&spec, |path| {
        hashes.set(hashes.get() + 1);
        fs::write(path, vec![b'x'; hashes.get() + 1]).unwrap();
        Ok(())
    });
    assert_eq!(verdict, None, "no verdict for a moving file");
    assert_eq!(hashes.get(), 3, "bounded");
    assert_eq!(store.known_verdict(&spec), None);
    assert!(!marker_path(&path).exists());
    let _ = fs::remove_dir_all(&dir);
}

//! status() fingerprint cache: hits, invalidation, and the unlocked hash window.

use super::*;
use sha2::{Digest, Sha256};

fn temp_root(name: &str) -> PathBuf {
    let root = crate::cleanup::test_support::test_root().join(format!("model-status-{name}"));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    root
}

fn spec_for(bytes: &[u8]) -> ArtifactSpec {
    ArtifactSpec {
        sha256: Box::leak(format!("{:x}", Sha256::digest(bytes)).into_boxed_str()),
        size: bytes.len() as u64,
    }
}

/// A fingerprint no real file has, to plant a stale cache entry.
fn stale_fingerprint() -> FileFingerprint {
    FileFingerprint {
        #[cfg(unix)]
        dev: 0,
        #[cfg(unix)]
        ino: 0,
        len: 8,
        modified: std::time::SystemTime::UNIX_EPOCH,
        #[cfg(unix)]
        ctime_secs: 0,
        #[cfg(unix)]
        ctime_nsecs: 0,
    }
}

#[cfg(unix)]
fn ctime(path: &Path) -> (i64, i64) {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::symlink_metadata(path).unwrap();
    (metadata.ctime(), metadata.ctime_nsec())
}

/// Block until the filesystem clock has ticked past `after`. ctime is only as
/// fine as that tick (coarse on e.g. Linux ext4), so back-to-back writes can
/// share one ctime. A probe in the same directory shows when it has moved.
#[cfg(unix)]
fn wait_for_ctime_tick(dir: &Path, after: (i64, i64)) {
    use std::time::{Duration, Instant};
    let probe = dir.join("ctime-probe");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        fs::write(&probe, b"tick").unwrap();
        if ctime(&probe) > after {
            break;
        }
        assert!(Instant::now() < deadline, "filesystem ctime never advanced");
        std::thread::sleep(Duration::from_millis(1));
    }
    let _ = fs::remove_file(probe);
}

#[test]
fn status_reuses_fingerprint_until_the_file_changes() {
    let root = temp_root("cache");
    let artifact = spec_for(b"GGUFtest");
    let store = CleanupModelStore::new(root.clone());
    fs::write(store.model_path(), b"GGUFtest").unwrap();
    assert!(store.status_available_for(artifact));
    assert!(
        store.inner.lock().unwrap().verified.is_some(),
        "successful status must remember the fingerprint"
    );
    // Unchanged fingerprint: a cache hit, so the hash step must not run.
    assert!(store.available_with(|_| panic!("cache hit must not re-hash")));
    assert!(store.inner.lock().unwrap().verified.is_some());
    // Same length, different bytes, after a clock tick → re-hash and miss.
    #[cfg(unix)]
    wait_for_ctime_tick(&root, ctime(&store.model_path()));
    #[cfg(not(unix))]
    std::thread::sleep(std::time::Duration::from_millis(20));
    fs::write(store.model_path(), b"GGUFevil").unwrap();
    assert!(!store.status_available_for(artifact));
    assert!(store.inner.lock().unwrap().verified.is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn missing_model_clears_stale_status_cache() {
    let root = temp_root("missing");
    let store = CleanupModelStore::new(root.clone());
    store.inner.lock().unwrap().verified = Some(stale_fingerprint());
    assert!(!store.status().available);
    assert!(store.inner.lock().unwrap().verified.is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn lease_is_not_blocked_while_status_hashes() {
    let root = temp_root("lease-during-hash");
    let artifact = spec_for(b"GGUFtest");
    let store = CleanupModelStore::new(root.clone());
    fs::write(store.model_path(), b"GGUFtest").unwrap();
    let mut inside = false;
    let available = store.available_with(|path| {
        inside = true;
        // Deterministically inside the hash window: the store lock must be
        // free here, so lease (and import) proceed while status hashes.
        assert!(
            store.inner.try_lock().is_ok(),
            "status must not hold the store lock during SHA-256"
        );
        let lease = store.lease_artifact(MODEL_ID, artifact);
        assert!(lease.is_ok(), "lease during status hash: {lease:?}");
        drop(lease);
        validate_artifact(path, artifact).is_ok()
    });
    assert!(inside, "cache miss must hash");
    assert!(available);
    assert!(store.inner.lock().unwrap().verified.is_some());
    assert_eq!(store.inner.lock().unwrap().leases, 0);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn status_does_not_cache_a_file_that_changed_mid_hash() {
    let root = temp_root("changed-mid-hash");
    let store = CleanupModelStore::new(root.clone());
    fs::write(store.model_path(), b"GGUFtest").unwrap();
    let available = store.available_with(|path| {
        // A different length always changes the fingerprint.
        fs::write(path, b"GGUFlonger").unwrap();
        true
    });
    assert!(available, "status reports this hash's own result");
    assert!(
        store.inner.lock().unwrap().verified.is_none(),
        "neither the hashed nor the new fingerprint may be cached"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn status_clears_cache_when_the_file_vanishes_mid_hash() {
    let root = temp_root("vanished-mid-hash");
    let store = CleanupModelStore::new(root.clone());
    fs::write(store.model_path(), b"GGUFtest").unwrap();
    store.inner.lock().unwrap().verified = Some(stale_fingerprint());
    let available = store.available_with(|path| {
        fs::remove_file(path).unwrap();
        false
    });
    assert!(!available);
    assert!(store.inner.lock().unwrap().verified.is_none());
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn status_detects_in_place_rewrite_when_mtime_restored() {
    use std::io::Write;
    let root = temp_root("ctime");
    let artifact = spec_for(b"GGUFtest");
    let store = CleanupModelStore::new(root.clone());
    let path = store.model_path();
    fs::write(&path, b"GGUFtest").unwrap();
    assert!(store.status_available_for(artifact));
    let cached = store.inner.lock().unwrap().verified.unwrap();
    let prior_mtime = fs::symlink_metadata(&path).unwrap().modified().unwrap();

    // Without a tick the rewrite can share the cached ctime and hit the cache.
    wait_for_ctime_tick(&root, (cached.ctime_secs, cached.ctime_nsecs));
    // Same length, different bytes; restore mtime so a pre-ctime key would hit.
    {
        let mut file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.write_all(b"GGUFevil").unwrap();
        file.sync_all().unwrap();
        file.set_modified(prior_mtime).unwrap();
    }
    let rewritten = fingerprint(&path).unwrap();
    assert_eq!(rewritten.modified, cached.modified, "mtime restored");
    assert_ne!(rewritten, cached, "ctime must move after the clock tick");

    assert!(
        !store.status_available_for(artifact),
        "ctime must invalidate the status cache after an in-place rewrite"
    );
    assert!(store.inner.lock().unwrap().verified.is_none());
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn status_does_not_follow_a_symlinked_model() {
    let root = temp_root("symlink");
    let artifact = spec_for(b"GGUFtest");
    let store = CleanupModelStore::new(root.clone());
    let target = root.join("elsewhere.gguf");
    fs::write(&target, b"GGUFtest").unwrap();
    std::os::unix::fs::symlink(&target, store.model_path()).unwrap();
    assert!(fingerprint(&store.model_path()).is_err());
    // Even a cache entry matching the target must not make a symlink count.
    store.inner.lock().unwrap().verified = Some(fingerprint(&target).unwrap());
    assert!(!store.status_available_for(artifact));
    assert!(store.inner.lock().unwrap().verified.is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn verify_failure_invalidates_status_cache() {
    let root = temp_root("verify-invalidate");
    let artifact = spec_for(b"GGUFtest");
    let store = CleanupModelStore::new(root.clone());
    fs::write(store.model_path(), b"GGUFevil").unwrap();
    // Plant a matching fingerprint so status would trust the cache.
    let planted = fingerprint(&store.model_path()).unwrap();
    store.inner.lock().unwrap().verified = Some(planted);
    assert!(
        store.status_available_for(artifact),
        "planted cache must hit"
    );

    let mut lease = store.lease_artifact(MODEL_ID, artifact).unwrap();
    assert!(lease.verify().unwrap_err().contains("SHA-256 mismatch"));
    assert!(
        store.inner.lock().unwrap().verified.is_none(),
        "failed verify must drop the status cache"
    );
    assert!(!store.status_available_for(artifact));
    drop(lease);
    let _ = fs::remove_dir_all(root);
}

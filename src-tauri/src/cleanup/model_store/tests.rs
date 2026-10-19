use super::*;
use sha2::{Digest, Sha256};

fn temp_root(name: &str) -> PathBuf {
    crate::cleanup::test_support::test_root().join(format!("model-store-{name}"))
}

#[test]
fn imports_atomically_with_private_permissions() {
    let root = temp_root("import");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let source = root.join("source.gguf");
    fs::write(&source, b"GGUFtest").unwrap();
    let digest = Box::leak(format!("{:x}", Sha256::digest(b"GGUFtest")).into_boxed_str());
    let installed = root.join("installed");
    let store = CleanupModelStore::new(installed.clone());
    store
        .import_artifact(
            &source,
            ArtifactSpec {
                sha256: digest,
                size: 8,
            },
        )
        .unwrap();
    let destination = installed.join(MODEL_FILE);
    assert_eq!(fs::read(&destination).unwrap(), b"GGUFtest");
    assert!(!installed.join(format!("{MODEL_FILE}.partial")).exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(destination).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn sync_failure_is_reported_after_rename_and_retry_syncs_existing_model() {
    let root = temp_root("directory-sync");
    fs::create_dir_all(&root).unwrap();
    let source = root.join("source.gguf");
    fs::write(&source, b"GGUFtest").unwrap();
    let spec = ArtifactSpec {
        sha256: Box::leak(format!("{:x}", Sha256::digest(b"GGUFtest")).into_boxed_str()),
        size: 8,
    };
    let installed = root.join("installed");
    let store = CleanupModelStore::new(installed.clone());
    let error = store
        .import_artifact_with_sync(&source, spec, |parent| {
            assert_eq!(parent, installed);
            assert_eq!(fs::read(parent.join(MODEL_FILE)).unwrap(), b"GGUFtest");
            assert!(!parent.join(format!("{MODEL_FILE}.partial")).exists());
            Err("directory sync failed".into())
        })
        .unwrap_err();
    assert_eq!(error, "directory sync failed");
    // The valid renamed file remains, but success is not claimed. Neither
    // the import guard nor retry may suppress another directory sync.
    let mut synced = false;
    store
        .import_artifact_with_sync(&source, spec, |parent| {
            assert_eq!(parent, installed);
            synced = true;
            Ok(())
        })
        .unwrap();
    assert!(synced);
    assert!(store.lease_artifact(MODEL_ID, spec).is_ok());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn refuses_import_while_a_model_is_leased() {
    let root = temp_root("leased");
    let store = CleanupModelStore::new(root.clone());
    store.inner.lock().unwrap().leases = 1;
    let error = store
        .import_artifact(
            Path::new("unused"),
            ArtifactSpec {
                sha256: "",
                size: 0,
            },
        )
        .unwrap_err();
    assert!(error.contains("in use"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn admission_opens_without_hashing_the_model() {
    let root = temp_root("cheap-admission");
    fs::create_dir_all(&root).unwrap();
    let store = CleanupModelStore::new(root.clone());
    fs::write(store.model_path(), b"GGUFevil").unwrap();
    // Admission is only a reservation. Full verification belongs immediately
    // before inference, on this same descriptor, not on the microphone path.
    let lease = store.lease_artifact(
        MODEL_ID,
        ArtifactSpec {
            sha256: "not-the-digest",
            size: 8,
        },
    );
    assert!(lease.is_ok(), "admission must not hash: {lease:?}");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn lease_rejects_same_size_tampering() {
    let root = temp_root("tamper");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let bytes = b"GGUFtest";
    let digest = Box::leak(format!("{:x}", Sha256::digest(bytes)).into_boxed_str());
    let store = CleanupModelStore::new(root.clone());
    fs::write(store.model_path(), b"GGUFevil").unwrap();
    let mut lease = store
        .lease_artifact(
            MODEL_ID,
            ArtifactSpec {
                sha256: digest,
                size: bytes.len() as u64,
            },
        )
        .unwrap();
    let error = lease.verify().unwrap_err();
    assert!(error.contains("SHA-256 mismatch"));
    assert_eq!(store.inner.lock().unwrap().leases, 1);
    drop(lease);
    assert_eq!(store.inner.lock().unwrap().leases, 0);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn bounds_descriptors_even_while_retired_acquisitions_are_finishing() {
    let root = temp_root("descriptor-capacity");
    fs::create_dir_all(&root).unwrap();
    let store = CleanupModelStore::new(root.clone());
    fs::write(store.model_path(), b"GGUFtest").unwrap();
    let first = store.lease(MODEL_ID).unwrap();
    let second = store.lease(MODEL_ID).unwrap();
    assert!(store.lease(MODEL_ID).is_err());
    drop(first);
    assert!(store.lease(MODEL_ID).is_ok());
    drop(second);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn verification_uses_the_reserved_descriptor_without_store_lock() {
    let root = temp_root("descriptor-verification");
    fs::create_dir_all(&root).unwrap();
    let bytes = b"GGUFtest";
    let digest = Box::leak(format!("{:x}", Sha256::digest(bytes)).into_boxed_str());
    let store = CleanupModelStore::new(root.clone());
    fs::write(store.model_path(), bytes).unwrap();
    let mut lease = store
        .lease_artifact(
            MODEL_ID,
            ArtifactSpec {
                sha256: digest,
                size: 8,
            },
        )
        .unwrap();
    fs::rename(store.model_path(), root.join("original.gguf")).unwrap();
    fs::write(store.model_path(), b"GGUFevil").unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    let lock = store.inner.lock().unwrap();
    let verifier = std::thread::spawn(move || {
        sender.send(lease.verify()).unwrap();
        lease
    });
    let result = receiver.recv_timeout(std::time::Duration::from_secs(2));
    drop(lock);
    let mut lease = verifier.join().unwrap();
    assert!(result.unwrap().is_ok());
    // Mutation of the held descriptor is still detected on re-verification.
    fs::write(root.join("original.gguf"), b"GGUFevil").unwrap();
    assert!(lease.verify().unwrap_err().contains("SHA-256 mismatch"));
    drop(lease);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn verified_lease_blocks_concurrent_import_until_drop() {
    let root = temp_root("lease-import");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let bytes = b"GGUFtest";
    let digest = Box::leak(format!("{:x}", Sha256::digest(bytes)).into_boxed_str());
    let artifact = ArtifactSpec {
        sha256: digest,
        size: bytes.len() as u64,
    };
    let store = CleanupModelStore::new(root.clone());
    fs::write(store.model_path(), bytes).unwrap();
    let first = store.lease_artifact(MODEL_ID, artifact).unwrap();
    let queued = store.lease_artifact(MODEL_ID, artifact).unwrap();
    assert!(store
        .import_artifact(&store.model_path(), artifact)
        .unwrap_err()
        .contains("in use"));
    drop(first);
    assert!(store
        .import_artifact(&store.model_path(), artifact)
        .unwrap_err()
        .contains("in use"));
    drop(queued);
    assert!(store.import_artifact(&store.model_path(), artifact).is_ok());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn status_reuses_fingerprint_until_the_file_changes() {
    let root = temp_root("status-cache");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let bytes = b"GGUFtest";
    let digest = Box::leak(format!("{:x}", Sha256::digest(bytes)).into_boxed_str());
    let artifact = ArtifactSpec {
        sha256: digest,
        size: bytes.len() as u64,
    };
    let store = CleanupModelStore::new(root.clone());
    fs::write(store.model_path(), bytes).unwrap();
    assert!(store.status_available_for(artifact));
    assert!(
        store.inner.lock().unwrap().verified.is_some(),
        "successful status must remember the fingerprint"
    );
    // Unchanged inode/size/mtime: second call must not clear the cache.
    assert!(store.status_available_for(artifact));
    assert!(store.inner.lock().unwrap().verified.is_some());
    // Same length, different bytes + new mtime → re-hash and miss.
    std::thread::sleep(std::time::Duration::from_millis(20));
    fs::write(store.model_path(), b"GGUFevil").unwrap();
    assert!(!store.status_available_for(artifact));
    assert!(store.inner.lock().unwrap().verified.is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn missing_model_clears_stale_status_cache() {
    let root = temp_root("status-missing");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let store = CleanupModelStore::new(root.clone());
    store.inner.lock().unwrap().verified = Some(super::FileFingerprint {
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
    });
    assert!(!store.status().available);
    assert!(store.inner.lock().unwrap().verified.is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn lease_is_not_blocked_while_status_hashes() {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    let root = temp_root("status-lease-concurrency");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    // ~16 MiB: long enough to observe the unlocked hash window even with
    // profile.dev.package.sha2 opt-level = 3.
    let mut bytes = vec![0u8; 16 << 20];
    bytes[..4].copy_from_slice(b"GGUF");
    let digest = Box::leak(format!("{:x}", Sha256::digest(&bytes)).into_boxed_str());
    let artifact = ArtifactSpec {
        sha256: digest,
        size: bytes.len() as u64,
    };
    let store = Arc::new(CleanupModelStore::new(root.clone()));
    fs::write(store.model_path(), &bytes).unwrap();

    let status_store = Arc::clone(&store);
    let status = std::thread::spawn(move || status_store.status_available_for(artifact));

    // Poll until status has released the lock for hashing (or finished).
    let unlocked = (0..200).any(|_| {
        std::thread::sleep(Duration::from_millis(1));
        if let Ok(guard) = store.inner.try_lock() {
            drop(guard);
            true
        } else {
            false
        }
    });
    assert!(
        unlocked,
        "status must release the store lock before SHA-256"
    );

    let started = Instant::now();
    let lease = store.lease_artifact(MODEL_ID, artifact);
    let waited = started.elapsed();
    assert!(lease.is_ok(), "lease during status hash: {lease:?}");
    assert!(
        waited < Duration::from_millis(200),
        "lease blocked for {waited:?} while status hashed (store lock held during SHA-256)"
    );
    drop(lease);
    assert!(status.join().unwrap());
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn status_detects_in_place_rewrite_when_mtime_restored() {
    use std::io::Write;
    let root = temp_root("status-ctime");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let bytes = b"GGUFtest";
    let digest = Box::leak(format!("{:x}", Sha256::digest(bytes)).into_boxed_str());
    let artifact = ArtifactSpec {
        sha256: digest,
        size: bytes.len() as u64,
    };
    let store = CleanupModelStore::new(root.clone());
    fs::write(store.model_path(), bytes).unwrap();
    assert!(store.status_available_for(artifact));
    assert!(store.inner.lock().unwrap().verified.is_some());

    let path = store.model_path();
    let prior_mtime = fs::symlink_metadata(&path).unwrap().modified().unwrap();
    // Same length, different bytes; restore mtime so a pre-ctime key would hit.
    {
        let mut file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.write_all(b"GGUFevil").unwrap();
        file.sync_all().unwrap();
    }
    let file = fs::File::options().write(true).open(&path).unwrap();
    file.set_modified(prior_mtime).unwrap();
    drop(file);

    assert!(
        !store.status_available_for(artifact),
        "ctime must invalidate the status cache after an in-place rewrite"
    );
    assert!(store.inner.lock().unwrap().verified.is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn verify_failure_invalidates_status_cache() {
    let root = temp_root("verify-invalidate");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let bytes = b"GGUFtest";
    let digest = Box::leak(format!("{:x}", Sha256::digest(bytes)).into_boxed_str());
    let artifact = ArtifactSpec {
        sha256: digest,
        size: bytes.len() as u64,
    };
    let store = CleanupModelStore::new(root.clone());
    fs::write(store.model_path(), b"GGUFevil").unwrap();
    // Plant a matching fingerprint so status would trust the cache.
    let fp = super::fingerprint(&store.model_path()).unwrap();
    store.inner.lock().unwrap().verified = Some(fp);
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

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

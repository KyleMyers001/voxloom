use super::*;
use sha2::{Digest, Sha256};
use std::fs;

fn temp_root(name: &str) -> PathBuf {
    crate::cleanup::test_support::test_root().join(format!("model-store-{name}"))
}

#[test]
fn refuses_a_write_while_a_model_is_leased() {
    let store = CleanupModelStore::new(temp_root("leased"));
    store.inner.lock().unwrap().leases = 1;
    assert!(store.begin_write().err().unwrap().contains("in use"));
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
fn verified_lease_blocks_a_write_until_drop() {
    let root = temp_root("lease-write");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let store = CleanupModelStore::new(root.clone());
    fs::write(store.model_path(), b"GGUFtest").unwrap();
    let first = store.lease(MODEL_ID).unwrap();
    let queued = store.lease(MODEL_ID).unwrap();
    assert!(store.begin_write().err().unwrap().contains("in use"));
    drop(first);
    assert!(store.begin_write().err().unwrap().contains("in use"));
    drop(queued);
    assert!(store.begin_write().is_ok());
    let _ = fs::remove_dir_all(root);
}

/// BUS-186: a model an earlier version imported is the same pinned file at
/// the same path, so it still counts as installed and can be leased.
#[test]
fn a_previously_imported_model_still_shows_as_installed() {
    let root = temp_root("previously-imported");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let bytes = b"GGUFtest";
    let artifact = ArtifactSpec {
        sha256: Box::leak(format!("{:x}", Sha256::digest(bytes)).into_boxed_str()),
        size: bytes.len() as u64,
    };
    let store = CleanupModelStore::new(root.clone());
    fs::write(root.join("qwen3-0.6b-q4-k-m.gguf"), bytes).unwrap();
    assert!(store.status_available_for(artifact));
    assert!(store.lease_artifact(MODEL_ID, artifact).is_ok());
    let _ = fs::remove_dir_all(root);
}

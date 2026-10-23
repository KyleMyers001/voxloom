//! The stoppable hash (BUS-125): a prewarm abandoned for a dictation stops
//! hashing the model, without touching what status trusts.

use std::fs;

use sha2::{Digest, Sha256};

use super::*;

const MIB: usize = 1024 * 1024;

/// A lease on a four-MiB model: a few chunks, so a hash can be stopped
/// part way. The bytes need not be a real model, only match the artifact.
fn big_lease(name: &str) -> (CleanupModelStore, ModelLease, std::path::PathBuf) {
    let root = crate::cleanup::test_support::test_root().join(format!("model-verify-{name}"));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let mut bytes = vec![7_u8; 4 * MIB];
    bytes[..4].copy_from_slice(b"GGUF");
    let sha256 = Box::leak(format!("{:x}", Sha256::digest(&bytes)).into_boxed_str());
    let artifact = ArtifactSpec {
        sha256,
        size: bytes.len() as u64,
    };
    let store = CleanupModelStore::new(root.clone());
    fs::write(store.model_path(), &bytes).unwrap();
    let lease = store.lease_artifact(MODEL_ID, artifact).unwrap();
    (store, lease, root)
}

#[test]
fn a_stopped_hash_reads_no_further_than_the_next_chunk() {
    let (_store, mut lease, root) = big_lease("stops");
    let mut asked = 0;
    // Abandoned after two chunks: the third is never read.
    let outcome = lease.verify_while(|| {
        asked += 1;
        asked <= 2
    });
    assert_eq!(outcome, Ok(false));
    assert_eq!(asked, 3, "asked once per chunk, and not again once stopped");
    drop(lease);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_hash_nobody_stops_verifies_every_chunk() {
    let (_store, mut lease, root) = big_lease("runs");
    let mut asked = 0;
    let outcome = lease.verify_while(|| {
        asked += 1;
        true
    });
    assert_eq!(outcome, Ok(true));
    assert_eq!(
        asked,
        4 + 1,
        "four chunks, then the empty read that ends it"
    );
    assert!(lease.verify().is_ok(), "plain verify is the same hash");
    drop(lease);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn stopping_keeps_the_status_cache_and_a_mismatch_still_drops_it() {
    let (store, mut lease, root) = big_lease("cache");
    let path = store.model_path();
    store.remember_verified(&path);
    assert_eq!(lease.verify_while(|| false), Ok(false));
    assert!(
        store.inner.lock().unwrap().verified.is_some(),
        "a stopped hash found nothing wrong"
    );
    // The lease holds this inode: change a byte past the header, same size.
    let mut bytes = fs::read(&path).unwrap();
    bytes[MIB] ^= 1;
    fs::write(&path, bytes).unwrap();
    assert!(lease.verify_while(|| true).is_err());
    assert!(store.inner.lock().unwrap().verified.is_none());
    drop(lease);
    fs::remove_dir_all(root).unwrap();
}

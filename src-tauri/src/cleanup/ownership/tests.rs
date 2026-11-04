use super::*;
use crate::cleanup::test_support::{process_exists, test_root, wait_until, write_executable};
use crate::cleanup::{
    artifact::ArtifactSpec,
    model_store::{CleanupModelStore, MODEL_ID},
};
use sha2::{Digest, Sha256};
use std::time::Duration;
use std::{fs, path::PathBuf, sync::Arc};

fn fixture(name: &str) -> (RequestRegistry, CleanupModelStore, PathBuf, ArtifactSpec) {
    let root = test_root().join(format!("owner-{name}"));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let source = root.join("source.gguf");
    fs::write(&source, b"GGUFtest").unwrap();
    let spec = ArtifactSpec {
        sha256: Box::leak(format!("{:x}", Sha256::digest(b"GGUFtest")).into_boxed_str()),
        size: 8,
    };
    let store = CleanupModelStore::new(root.join("models"));
    store.import_artifact(&source, spec).unwrap();
    let registry =
        RequestRegistry::new(Arc::new(WorkerSupervisor::new(root.join("missing-worker"))));
    (registry, store, source, spec)
}

fn acquire(
    registry: &RequestRegistry,
    store: &CleanupModelStore,
    spec: ArtifactSpec,
    owner: u64,
    id: &str,
) {
    let token = registry.begin_acquire(owner, id).unwrap();
    registry
        .complete_acquire(token, store.lease_artifact(MODEL_ID, spec))
        .unwrap();
}

#[test]
fn retirement_reclaims_pending_and_invalidates_late_acquisition() {
    let (registry, store, source, spec) = fixture("pending");
    let (owner, _) = registry.open_session();
    acquire(&registry, &store, spec, owner, "pending");
    let late = registry.begin_acquire(owner, "late").unwrap();
    let late_lease = store.lease_artifact(MODEL_ID, spec).unwrap();
    registry.retire(None).finish();
    assert!(store
        .import_artifact(&source, spec)
        .unwrap_err()
        .contains("in use"));
    assert_eq!(
        registry
            .complete_acquire(late, Ok(late_lease))
            .unwrap_err()
            .code,
        "cancelled"
    );
    assert!(store.import_artifact(&source, spec).is_ok());
    let (new_owner, _) = registry.open_session();
    assert_ne!(owner, new_owner);
    assert!(registry.begin_acquire(owner, "stale").is_err());
    acquire(&registry, &store, spec, new_owner, "fresh");
    registry.retire(None).finish();
}

#[test]
fn cancel_during_acquire_cannot_attach_to_a_later_same_id_request() {
    let (registry, store, source, spec) = fixture("acquiring");
    let (owner, _) = registry.open_session();
    let old = registry.begin_acquire(owner, "same").unwrap();
    let old_lease = store.lease_artifact(MODEL_ID, spec).unwrap();
    assert!(registry.settle(owner, "same").unwrap());
    assert!(!registry.settle(owner, "same").unwrap());
    let next = registry.begin_acquire(owner, "same").unwrap();
    assert!(registry.complete_acquire(old, Ok(old_lease)).is_err());
    registry
        .complete_acquire(next, store.lease_artifact(MODEL_ID, spec))
        .unwrap();
    assert!(store
        .import_artifact(&source, spec)
        .unwrap_err()
        .contains("in use"));
    assert!(registry.settle(owner, "same").unwrap());
    assert!(store.import_artifact(&source, spec).is_ok());
}

#[test]
fn active_a_survives_queued_b_release_and_blocks_import_until_task_settles() {
    let (registry, store, source, spec) = fixture("active-queued");
    let (owner, _) = registry.open_session();
    acquire(&registry, &store, spec, owner, "a");
    acquire(&registry, &store, spec, owner, "b");
    assert!(registry.begin_acquire(owner, "third").is_err());
    let active = registry.start_run(owner, "a", MODEL_ID).unwrap();
    assert!(registry.settle(owner, "b").unwrap());
    assert!(!registry.settle(owner, "b").unwrap());
    assert!(!active.cancelled());
    assert!(store
        .import_artifact(&source, spec)
        .unwrap_err()
        .contains("in use"));
    let retirement = registry.retire(None);
    assert!(active.cancelled());
    assert!(store
        .import_artifact(&source, spec)
        .unwrap_err()
        .contains("in use"));
    let (next_owner, _) = registry.open_session();
    acquire(&registry, &store, spec, next_owner, "next");
    assert!(registry.start_run(next_owner, "next", MODEL_ID).is_err());
    drop(active);
    retirement.finish();
    // Same supervisor can reserve the new generation once A is fully settled.
    let next = registry.start_run(next_owner, "next", MODEL_ID).unwrap();
    drop(next);
    assert!(store.import_artifact(&source, spec).is_ok());
}

#[test]
fn stale_owner_cannot_release_run_or_dispose_the_new_owner() {
    let (registry, store, source, spec) = fixture("wrong-owner");
    let (old_owner, _) = registry.open_session();
    let (owner, old) = registry.open_session();
    old.finish();
    acquire(&registry, &store, spec, owner, "same");
    assert!(registry.settle(old_owner, "same").is_err());
    assert!(registry.start_run(old_owner, "same", MODEL_ID).is_err());
    registry.retire(Some(old_owner)).finish();
    assert!(store
        .import_artifact(&source, spec)
        .unwrap_err()
        .contains("in use"));
    assert!(registry.start_run(owner, "same", "wrong-model").is_err());
    assert!(registry.settle(owner, "same").unwrap());
    assert!(store.import_artifact(&source, spec).is_ok());
}

#[test]
fn tampering_after_admission_is_rejected_before_worker_spawn() {
    let (_, store, source, spec) = fixture("tamper-before-run");
    let root = source.parent().unwrap();
    let marker = root.join("unexpected-spawn");
    let worker = root.join("worker.sh");
    write_executable(
        &worker,
        &format!(
            "#!/bin/sh\nprintf spawned > '{}'\nexit 7\n",
            marker.display()
        ),
    );
    let registry = RequestRegistry::new(Arc::new(WorkerSupervisor::new(worker)));
    let (owner, _) = registry.open_session();
    acquire(&registry, &store, spec, owner, "tampered");
    fs::write(root.join("models/qwen3-0.6b-q4-k-m.gguf"), b"GGUFevil").unwrap();
    let error = registry
        .start_run(owner, "tampered", MODEL_ID)
        .unwrap()
        .run("synthetic prompt".into())
        .unwrap_err();
    assert_eq!(error.code, "model-missing");
    assert!(error.attempt.is_none());
    assert!(error.message.contains("SHA-256 mismatch"));
    assert!(!marker.exists());
    assert!(store.import_artifact(&source, spec).is_ok());
}

#[test]
fn retiring_an_actual_worker_reaps_it_then_new_generation_runs() {
    let (_, store, source, spec) = fixture("worker-retirement");
    let root = source.parent().unwrap();
    let marker = root.join("started");
    let path = root.join("worker.py");
    // The marker is renamed into place, so once it exists it holds the pid:
    // a worker killed mid-write cannot leave it empty.
    write_executable(
        &path,
        &format!(
            r#"#!/usr/bin/env python3
import json, os, struct, sys, time
from pathlib import Path
size = struct.unpack('>I', sys.stdin.buffer.read(4))[0]
request = json.loads(sys.stdin.buffer.read(size))
with open(request['modelPath'], 'rb') as model:
    assert model.read() == b'GGUFtest'
marker = Path(r'{}')
if not marker.exists():
    staged = marker.with_suffix('.tmp')
    staged.write_text(str(os.getpid()))
    os.replace(staged, marker)
    time.sleep(60)
data = json.dumps({{'requestId': request['requestId'], 'status': 'ok', 'text': 'Recovered.'}}).encode()
sys.stdout.buffer.write(struct.pack('>I', len(data)) + data)
sys.stdout.buffer.flush()
"#,
            marker.display()
        ),
    );
    let registry = RequestRegistry::new(Arc::new(WorkerSupervisor::new(path)));
    let (owner, _) = registry.open_session();
    acquire(&registry, &store, spec, owner, "active");
    acquire(&registry, &store, spec, owner, "queued");
    let run = registry.start_run(owner, "active", MODEL_ID).unwrap();
    let running = std::thread::spawn(move || run.run("synthetic prompt".into()));
    let mut pid = None;
    let started = wait_until(Duration::from_secs(10), || {
        pid = fs::read_to_string(&marker)
            .ok()
            .and_then(|text| text.trim().parse::<libc::pid_t>().ok());
        pid.is_some()
    });
    registry.retire(None).finish();
    let error = running.join().unwrap().unwrap_err();
    assert_eq!(error.code, "cancelled");
    assert_eq!(error.attempt.unwrap().model_digest, spec.sha256);
    assert!(
        started,
        "fixture worker did not record its pid within ten seconds"
    );
    let pid = pid.unwrap();
    assert!(
        wait_until(Duration::from_secs(5), || !process_exists(pid)),
        "retired worker {pid} still exists five seconds after retirement"
    );
    assert!(store.import_artifact(&source, spec).is_ok());
    let (next_owner, _) = registry.open_session();
    acquire(&registry, &store, spec, next_owner, "after-retirement");
    let next = registry
        .start_run(next_owner, "after-retirement", MODEL_ID)
        .unwrap();
    let mut emitted = None;
    let result = next
        .run_with_attempt("synthetic prompt".into(), |attempt| emitted = Some(attempt))
        .unwrap();
    assert_eq!(result.text, "Recovered.");
    assert_eq!(result.attempt.model_id, MODEL_ID);
    assert_eq!(result.attempt.model_digest, spec.sha256);
    assert_eq!(emitted.unwrap().model_digest, spec.sha256);
    assert!(store.import_artifact(&source, spec).is_ok());
}

#[test]
fn attempt_identity_requires_verified_descriptor_and_successful_spawn() {
    let (_, store, source, spec) = fixture("attempt-evidence");
    let path = source.parent().unwrap().join("worker.sh");
    let registry = RequestRegistry::new(Arc::new(WorkerSupervisor::new(path.clone())));
    let (owner, _) = registry.open_session();
    for (id, prompt, expected_code) in [
        ("missing", "p".into(), "worker-missing"),
        ("oversize", "x".repeat(128 * 1024), "context-overflow"),
    ] {
        acquire(&registry, &store, spec, owner, id);
        let error = registry
            .start_run(owner, id, MODEL_ID)
            .unwrap()
            .run_with_attempt(prompt, |_| panic!("preflight is not an attempt"))
            .unwrap_err();
        assert_eq!(error.code, expected_code);
        assert!(error.attempt.is_none());
    }
    // Executable, but exec itself fails: still no attempt.
    write_executable(&path, "#!/missing/interpreter\n");
    acquire(&registry, &store, spec, owner, "spawn-failure");
    let error = registry
        .start_run(owner, "spawn-failure", MODEL_ID)
        .unwrap()
        .run_with_attempt("p".into(), |_| panic!("failed spawn is not an attempt"))
        .unwrap_err();
    assert!(error.attempt.is_none());
    // A launched child that crashes is an actual attempt with verified identity.
    write_executable(&path, "#!/bin/sh\nexit 7\n");
    acquire(&registry, &store, spec, owner, "crash");
    let mut emitted = None;
    let error = registry
        .start_run(owner, "crash", MODEL_ID)
        .unwrap()
        .run_with_attempt("p".into(), |attempt| emitted = Some(attempt))
        .unwrap_err();
    let attempt = emitted.unwrap();
    assert_eq!(attempt.model_id, MODEL_ID);
    assert_eq!(attempt.model_digest, spec.sha256);
    assert_eq!(error.attempt.unwrap().model_digest, spec.sha256);
    assert!(store.import_artifact(&source, spec).is_ok());
}

#[test]
fn failed_or_duplicate_acquisition_does_not_consume_capacity() {
    let (registry, store, _, spec) = fixture("failed-acquire");
    let (owner, _) = registry.open_session();
    let failed = registry.begin_acquire(owner, "failure").unwrap();
    assert!(registry
        .complete_acquire(failed, Err("model absent".into()))
        .is_err());
    acquire(&registry, &store, spec, owner, "one");
    assert!(registry.begin_acquire(owner, "one").is_err());
    acquire(&registry, &store, spec, owner, "two");
    registry.retire(None).finish();
}

//! `cleanup_run`'s admission step (BUS-16 3c-2c): the worker frame it leads
//! to carries the renderer's time left, so the worker can cap its output.

use std::fs;
use std::sync::Arc;

use sha2::{Digest, Sha256};

use super::{begin_acquire, start_run};
use crate::cleanup::artifact::ArtifactSpec;
use crate::cleanup::model_store::{CleanupModelStore, MODEL_ID};
use crate::cleanup::ownership::RequestRegistry;
use crate::cleanup::supervisor::WorkerSupervisor;
use crate::cleanup::test_support::{test_root, write_executable};
use crate::cleanup::CleanupRequestDto;

/// A worker that replies with the `timeLeftMs` of the frame it was sent.
const ECHO_WORKER: &str = r#"#!/usr/bin/env python3
import json, struct, sys
size = struct.unpack('>I', sys.stdin.buffer.read(4))[0]
request = json.loads(sys.stdin.buffer.read(size))
reply = json.dumps({"error": None, "errorCode": None, "requestId": request["requestId"],
                    "status": "ok", "text": str(request.get("timeLeftMs", "absent"))}).encode()
sys.stdout.buffer.write(struct.pack('>I', len(reply)) + reply)
sys.stdout.buffer.flush()
"#;

/// The `timeLeftMs` the worker saw for a `cleanup_run` request.
fn worker_time_left(name: &str, time_left_ms: Option<u64>) -> String {
    let root = test_root().join(format!("commands-{name}"));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let worker = root.join("worker.py");
    write_executable(&worker, ECHO_WORKER);
    let source = root.join("source.gguf");
    fs::write(&source, b"GGUFtest").unwrap();
    let spec = ArtifactSpec {
        sha256: Box::leak(format!("{:x}", Sha256::digest(b"GGUFtest")).into_boxed_str()),
        size: 8,
    };
    let store = CleanupModelStore::new(root.join("models"));
    store.import_artifact(&source, spec).unwrap();
    let registry = RequestRegistry::new(Arc::new(WorkerSupervisor::new(worker)));
    let (owner, _) = registry.open_session();
    let token = registry.begin_acquire(owner, "run").unwrap();
    registry
        .complete_acquire(token, store.lease_artifact(MODEL_ID, spec))
        .unwrap();
    let request: CleanupRequestDto = serde_json::from_value(serde_json::json!({
        "modelId": MODEL_ID,
        "prompt": "prompt",
        "rawText": "raw",
        "requestId": "run",
        "timeLeftMs": time_left_ms,
    }))
    .unwrap();
    let text = start_run(&registry, &owner.to_string(), &request)
        .unwrap()
        .run("prompt".into())
        .unwrap();
    registry.retire(None).finish();
    let _ = fs::remove_dir_all(root);
    text
}

#[test]
fn cleanup_run_sends_the_worker_its_time_left() {
    // Without the deadline the worker would get no `timeLeftMs` and fall
    // back to its size-based token budget (QA #117 Low-2).
    let left: u64 = worker_time_left("time-left", Some(5_000))
        .parse()
        .expect("the worker frame carries timeLeftMs");
    assert!((3_000..=5_000).contains(&left), "{left}");
}

#[test]
fn cleanup_run_without_time_left_sends_none() {
    assert_eq!(worker_time_left("no-time-left", None), "absent");
}

/// BUS-135: a build without a worker refuses the lease before it hashes the
/// model, with its own reason rather than a generic runtime error.
#[test]
fn acquire_without_a_worker_is_worker_missing_and_reserves_nothing() {
    let root = test_root().join("commands-no-worker");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let worker = root.join("worker.sh");
    let supervisor = Arc::new(WorkerSupervisor::new(worker.clone()));
    let registry = RequestRegistry::new(Arc::clone(&supervisor));
    let (owner, _) = registry.open_session();
    let error = begin_acquire(&registry, &supervisor, owner, "r")
        .err()
        .unwrap();
    assert_eq!(error.code, "worker-missing");
    // Nothing was reserved: once a worker is installed, the same ID acquires.
    write_executable(&worker, "#!/bin/sh\n");
    assert!(begin_acquire(&registry, &supervisor, owner, "r").is_ok());
    let _ = fs::remove_dir_all(root);
}

//! The prewarm triggers (BUS-16 3c-2c C2): switch-on always, launch unless
//! Low Power Mode, and only with a worker and a verified model.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use sha2::{Digest, Sha256};

use super::{prewarm, Trigger};
use crate::cleanup::artifact::ArtifactSpec;
use crate::cleanup::model_store::{CleanupModelStore, MODEL_ID};
use crate::cleanup::supervisor::WorkerSupervisor;
use crate::cleanup::test_support::{test_root, wait_until, write_executable};

/// A store with a verified test model, and a supervisor whose fake worker
/// warms up at once and writes "spawned" to the returned log.
fn fixture(name: &str) -> (CleanupModelStore, ArtifactSpec, WorkerSupervisor, PathBuf) {
    let root = test_root().join(format!("prewarm-{name}"));
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
    let log = root.join("spawned.log");
    let worker = root.join("worker.py");
    write_executable(
        &worker,
        &format!(
            "#!/usr/bin/env python3\nimport json, struct, sys\n\
             open({log:?}, 'a').write('spawned\\n')\n\
             body = sys.stdin.buffer.read(struct.unpack('>I', sys.stdin.buffer.read(4))[0])\n\
             assert json.loads(body)['prewarm']\n\
             data = json.dumps({{'error': None, 'errorCode': None, 'requestId': 'prewarm', \
             'status': 'ok', 'text': 'warm'}}).encode()\n\
             sys.stdout.buffer.write(struct.pack('>I', len(data)) + data)\n\
             sys.stdout.buffer.flush()\n"
        ),
    );
    (store, spec, WorkerSupervisor::new(worker), log)
}

fn spawned(log: &std::path::Path) -> bool {
    wait_until(Duration::from_secs(5), || log.exists())
}

#[test]
fn switch_on_always_prewarms_even_in_low_power_mode() {
    let (store, spec, supervisor, log) = fixture("switch-on");
    let outcome = prewarm(
        &supervisor,
        Trigger::SwitchOn,
        || true,
        || store.lease_artifact(MODEL_ID, spec),
    );
    assert_eq!(outcome, "started");
    assert!(spawned(&log));
}

#[test]
fn launch_prewarms_unless_low_power_mode() {
    let (store, spec, supervisor, log) = fixture("launch");
    let lease = || store.lease_artifact(MODEL_ID, spec);
    assert_eq!(
        prewarm(&supervisor, Trigger::Launch, || true, lease),
        "low-power"
    );
    assert!(!log.exists(), "nothing spawned in Low Power Mode");
    assert!(
        supervisor.reserve_prewarm().is_some(),
        "nothing reserved either"
    );
    assert_eq!(
        prewarm(&supervisor, Trigger::Launch, || false, lease),
        "started"
    );
    assert!(spawned(&log));
}

#[test]
fn no_model_or_a_bad_one_skips_and_frees_the_slot() {
    let (store, spec, supervisor, log) = fixture("no-model");
    let missing = || Err::<_, String>("no cleanup model".into());
    assert_eq!(
        prewarm(&supervisor, Trigger::SwitchOn, || false, missing),
        "unavailable"
    );
    let wrong = ArtifactSpec {
        sha256: "0".repeat(64).leak(),
        size: 8,
    };
    let tampered = || store.lease_artifact(MODEL_ID, wrong);
    assert_eq!(
        prewarm(&supervisor, Trigger::SwitchOn, || false, tampered),
        "unavailable"
    );
    assert!(!log.exists());
    let good = || store.lease_artifact(MODEL_ID, spec);
    assert_eq!(
        prewarm(&supervisor, Trigger::SwitchOn, || false, good),
        "started"
    );
}

#[test]
fn a_running_dictation_or_missing_worker_skips_it() {
    let (store, spec, supervisor, log) = fixture("busy");
    let lease = || store.lease_artifact(MODEL_ID, spec);
    let reservation = supervisor.reserve("dictation".into()).unwrap();
    assert_eq!(
        prewarm(&supervisor, Trigger::SwitchOn, || false, lease),
        "busy"
    );
    drop(reservation);
    let none = WorkerSupervisor::new(PathBuf::new());
    assert_eq!(
        prewarm(&none, Trigger::SwitchOn, || false, lease),
        "unavailable"
    );
    assert!(!log.exists());
}

#[test]
fn only_the_two_triggers_are_accepted() {
    assert_eq!(Trigger::parse("launch").unwrap(), Trigger::Launch);
    assert_eq!(Trigger::parse("switch-on").unwrap(), Trigger::SwitchOn);
    assert_eq!(Trigger::parse("login").unwrap_err().code, "runtime-error");
}

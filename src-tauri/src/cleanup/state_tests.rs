//! Startup fallback (BUS-98): `CleanupState` built without an `AppHandle`.

use std::fs;

use super::model_store::CleanupModelStore;
use super::test_support::{test_root, write_executable};
use super::CleanupState;

/// What `cleanup_model_status` reports: the store's status plus the
/// supervisor's runtime availability.
fn reported_status(state: &CleanupState) -> (bool, bool) {
    let mut status = state.models.status();
    status.runtime_available = state.supervisor.available();
    (status.available, status.runtime_available)
}

/// Fallback: empty worker path (runtime unavailable) and a temp model root
/// with no model installed (nothing is ever imported into it).
fn assert_fallback(state: &CleanupState) {
    let (model_available, runtime_available) = reported_status(state);
    assert!(
        !runtime_available,
        "fallback must report the runtime unavailable"
    );
    assert!(
        !model_available,
        "fallback temp root must report no model installed"
    );
}

#[test]
fn fallback_reports_runtime_and_model_unavailable() {
    assert_fallback(&CleanupState::fallback());
}

#[test]
fn setup_error_falls_back_instead_of_panicking() {
    let state = CleanupState::or_fallback(Err("resolve app data: no home directory".into()));
    assert_fallback(&state);
}

#[test]
fn setup_success_keeps_the_resolved_state() {
    let root = test_root().join("state-or-fallback");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let worker = root.join("worker");
    write_executable(&worker, "#!/bin/sh\nexit 0\n");
    let resolved = CleanupState::with_parts(CleanupModelStore::new(root.join("models")), worker);
    let (_, runtime_available) = reported_status(&CleanupState::or_fallback(Ok(resolved)));
    assert!(
        runtime_available,
        "Ok(state) must be kept, not replaced by the fallback"
    );
    let _ = fs::remove_dir_all(root);
}

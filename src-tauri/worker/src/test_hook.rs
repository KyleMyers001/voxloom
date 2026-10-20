//! Debug builds only: seams for the contract tests, without a real model.
//! A generation that never finishes on its own, so a test can kill the app
//! mid-generation (tests/parent_death.rs), and a panic that quotes the
//! request, so a test can check the panic hook (tests/panic_hook.rs).
//! Release builds, the ones the app bundles, have no such paths, and the app
//! clears the worker's environment anyway.

use std::time::Duration;

use crate::error::WorkerError;
use crate::output;

pub const SLOW_GENERATION_ENV: &str = "VOXLOOM_WORKER_TEST_SLOW_GENERATION";
pub const PANIC_ENV: &str = "VOXLOOM_WORKER_TEST_PANIC";

/// Panic with the prompt in the payload, as a bug deep in generation might.
/// The hook in main.rs must keep it off stderr (BUS-16 10555 L3, mutant W11).
pub fn panic_if_asked(prompt: &str) {
    if std::env::var_os(PANIC_ENV).is_some() {
        panic!("test panic while cleaning: {prompt}");
    }
}

/// One piece every 10 ms through the real output loop: about five minutes
/// before the byte cap ends it.
pub fn slow_generation() -> Option<Result<String, WorkerError>> {
    std::env::var_os(SLOW_GENERATION_ENV)?;
    Some(output::collect(usize::MAX, || {
        std::thread::sleep(Duration::from_millis(10));
        Ok(Some(b"x".to_vec()))
    }))
}

//! Debug builds only: a generation that never finishes on its own, so the
//! contract tests can kill the app mid-generation without a real model
//! (tests/parent_death.rs). Release builds, the ones the app bundles, have
//! no such path, and the app clears the worker's environment anyway.

use std::time::{Duration, Instant};

use crate::error::WorkerError;
use crate::output;

pub const SLOW_GENERATION_ENV: &str = "VOXLOOM_WORKER_TEST_SLOW_GENERATION";

/// One piece every 10 ms through the real output loop: about five minutes
/// before the byte cap ends it.
/// The app's time cap applies, as for a real model (deadline.rs).
pub fn slow_generation(deadline: Option<Instant>) -> Option<Result<String, WorkerError>> {
    std::env::var_os(SLOW_GENERATION_ENV)?;
    let limit = crate::deadline::limit(usize::MAX, deadline, Instant::now());
    let reply = output::collect(limit.tokens, || {
        std::thread::sleep(Duration::from_millis(10));
        Ok(Some(b"x".to_vec()))
    });
    Some(reply.map_err(|error| limit.explain(error)))
}

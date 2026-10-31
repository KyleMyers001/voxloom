//! One request: check the fields, run the model, build the reply.

use std::time::{Duration, Instant};

use crate::engine::{self, Generate};
use crate::error::WorkerError;
use crate::protocol::{WorkerRequest, WorkerResponse};

/// The only model path the app sends: the descriptor it passed on fd 3.
pub const MODEL_PATH: &str = "/dev/fd/3";

/// The one-request path: load the model, then run.
pub fn handle(request: WorkerRequest, started: Instant) -> WorkerResponse {
    respond(request, started, |prompt, deadline| {
        engine::generate(MODEL_PATH, prompt, deadline)
    })
}

/// A request handed to a prewarmed worker: the model is already loaded
/// (prewarm.rs). Its time left counts from when its frame arrived, and it
/// stops at the next token once `preempt` says a newer request came.
pub fn handle_loaded(
    engine: &dyn Generate,
    request: WorkerRequest,
    arrived: Instant,
    preempt: &mut dyn FnMut() -> bool,
) -> WorkerResponse {
    respond(request, arrived, |prompt, deadline| {
        engine.generate(prompt, deadline, usize::MAX, preempt)
    })
}

fn respond(
    request: WorkerRequest,
    started: Instant,
    run: impl FnOnce(&str, Option<Instant>) -> Result<String, WorkerError>,
) -> WorkerResponse {
    let request_id = request.request_id;
    let deadline = request
        .time_left_ms
        .map(|ms| started + Duration::from_millis(ms));
    let result = check(&request.model_path, &request.prompt).and_then(|()| {
        #[cfg(debug_assertions)]
        crate::test_hook::panic_if_asked(&request.prompt);
        #[cfg(debug_assertions)]
        if let Some(result) = crate::test_hook::slow_generation(deadline) {
            return result;
        }
        run(&request.prompt, deadline)
    });
    match result {
        Ok(text) => ok_response(request_id, text),
        Err(error) => error.into_response(request_id),
    }
}

/// Never open a path from the request; the app always hands over fd 3.
pub fn check(model_path: &str, prompt: &str) -> Result<(), WorkerError> {
    if model_path != MODEL_PATH {
        return Err(WorkerError::runtime("unsupported model path"));
    }
    if prompt.trim().is_empty() {
        return Err(WorkerError::runtime("empty prompt"));
    }
    Ok(())
}

pub fn ok_response(request_id: String, text: String) -> WorkerResponse {
    WorkerResponse {
        error: None,
        error_code: None,
        request_id,
        status: "ok".into(),
        text: Some(text),
    }
}

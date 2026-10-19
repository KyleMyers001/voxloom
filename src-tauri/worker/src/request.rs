//! One request: check the fields, run the model, build the reply.

use crate::engine;
use crate::error::WorkerError;
use crate::protocol::{WorkerRequest, WorkerResponse};

/// The only model path the app sends: the descriptor it passed on fd 3.
pub const MODEL_PATH: &str = "/dev/fd/3";

pub fn handle(request: WorkerRequest) -> WorkerResponse {
    let request_id = request.request_id;
    match run(&request.model_path, &request.prompt) {
        Ok(text) => ok_response(request_id, text),
        Err(error) => error.into_response(request_id),
    }
}

fn run(model_path: &str, prompt: &str) -> Result<String, WorkerError> {
    // Never open a path from the request; the app always hands over fd 3.
    if model_path != MODEL_PATH {
        return Err(WorkerError::runtime("unsupported model path"));
    }
    if prompt.trim().is_empty() {
        return Err(WorkerError::runtime("empty prompt"));
    }
    engine::generate(MODEL_PATH, prompt)
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

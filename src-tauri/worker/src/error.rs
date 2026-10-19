//! Worker failures as protocol error frames. Codes are the closed set the
//! app supervisor maps (supervisor/response.rs); messages are fixed strings
//! that never quote the request.

use crate::protocol::WorkerResponse;

#[derive(Debug, PartialEq, Eq)]
pub struct WorkerError {
    pub code: &'static str,
    pub message: &'static str,
}

impl WorkerError {
    pub fn runtime(message: &'static str) -> Self {
        Self {
            code: "runtime-error",
            message,
        }
    }

    pub fn model(message: &'static str) -> Self {
        Self {
            code: "model-missing",
            message,
        }
    }

    pub fn overflow(message: &'static str) -> Self {
        Self {
            code: "context-overflow",
            message,
        }
    }

    pub fn output(message: &'static str) -> Self {
        Self {
            code: "invalid-output",
            message,
        }
    }

    pub fn into_response(self, request_id: String) -> WorkerResponse {
        WorkerResponse {
            error: Some(self.message.to_owned()),
            error_code: Some(self.code.to_owned()),
            request_id,
            status: "error".into(),
            text: None,
        }
    }
}

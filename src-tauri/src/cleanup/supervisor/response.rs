//! Validation of a worker reply: request-ID binding, bounded diagnostics,
//! a closed set of error codes, and an output size cap.

use super::super::protocol::WorkerResponse;
use super::SupervisorError;

/// Map one worker reply to cleaned text or a bounded supervisor error.
pub(super) fn interpret(
    response: WorkerResponse,
    request_id: &str,
) -> Result<String, SupervisorError> {
    if response.request_id != request_id
        && !(response.status == "error" && response.request_id.is_empty())
    {
        return Err(SupervisorError::runtime(
            "cleanup worker response request ID mismatch",
        ));
    }
    if response.status == "error" {
        let (Some(code), Some(message)) = (response.error_code, response.error) else {
            return Err(SupervisorError::runtime("malformed cleanup worker error"));
        };
        if response.text.is_some()
            || code.is_empty()
            || code.len() > 64
            || message.is_empty()
            || message.len() > 1024
        {
            return Err(SupervisorError::runtime(
                "invalid cleanup worker error bounds",
            ));
        }
        return Err(SupervisorError {
            code: match code.as_str() {
                "context-overflow" => "context-overflow",
                "model-missing" => "model-missing",
                "invalid-output" => "invalid-output",
                _ => "runtime-error",
            },
            message,
        });
    }
    if response.status != "ok" || response.error.is_some() || response.error_code.is_some() {
        return Err(SupervisorError::runtime(
            "malformed cleanup worker response",
        ));
    }
    let text = response
        .text
        .ok_or_else(|| SupervisorError::runtime("cleanup worker returned no text"))?;
    if text.len() > 32_000 {
        return Err(SupervisorError {
            code: "invalid-output",
            message: "cleanup output exceeds 32000 UTF-8 bytes".into(),
        });
    }
    Ok(text)
}

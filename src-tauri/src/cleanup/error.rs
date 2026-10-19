//! Command DTOs and the bounded error shape returned to the renderer.

use serde::Deserialize;

use super::supervisor;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupAttempt {
    pub(super) model_id: &'static str,
    pub(super) model_digest: &'static str,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupRunOutput {
    pub(super) attempt: CleanupAttempt,
    pub(super) text: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCommandError {
    pub(super) code: &'static str,
    pub(super) message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) attempt: Option<CleanupAttempt>,
}

impl CleanupCommandError {
    pub(super) fn runtime(message: impl Into<String>) -> Self {
        Self {
            code: "runtime-error",
            message: message.into(),
            attempt: None,
        }
    }

    pub(super) fn cancelled() -> Self {
        Self {
            code: "cancelled",
            message: "cleanup session or request was retired".into(),
            attempt: None,
        }
    }

    pub(super) fn model(message: String) -> Self {
        Self {
            code: "model-missing",
            message,
            attempt: None,
        }
    }
}

impl From<supervisor::SupervisorError> for CleanupCommandError {
    fn from(error: supervisor::SupervisorError) -> Self {
        Self {
            code: error.code,
            message: error.message,
            attempt: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupRequestDto {
    pub(super) model_id: String,
    pub(super) prompt: String,
    pub(super) raw_text: String,
    pub(super) request_id: String,
}

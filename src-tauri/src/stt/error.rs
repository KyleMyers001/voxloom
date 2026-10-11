//! Structured STT errors shared with the TypeScript adapter.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SttErrorDto {
    pub code: String,
    pub message: String,
}

impl SttErrorDto {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }

    pub fn to_string_payload(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            format!(r#"{{"code":"{}","message":"{}"}}"#, self.code, self.message)
        })
    }
}

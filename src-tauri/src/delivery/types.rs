use serde::{Deserialize, Serialize};

/// Mirrors TypeScript `TargetSnapshot` for IPC.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetSnapshotDto {
    pub app_name: Option<String>,
    pub app_pid: Option<i32>,
    pub captured_at: i64,
    pub element_id: Option<String>,
    pub element_role: Option<String>,
    pub insertable: bool,
    pub kind: String,
    pub reason: Option<String>,
}

impl TargetSnapshotDto {
    pub fn unavailable(reason: &str, captured_at: i64) -> Self {
        Self {
            app_name: None,
            app_pid: None,
            captured_at,
            element_id: None,
            element_role: None,
            insertable: false,
            kind: "unavailable".into(),
            reason: Some(reason.into()),
        }
    }
}

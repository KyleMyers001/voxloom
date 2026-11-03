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
    /// Frontmost app is a known terminal (copy hint only). Absent in older
    /// payloads, which read as false.
    #[serde(default)]
    pub known_terminal: bool,
    /// Frontmost app is a terminal (or Apple Messages) the paste route
    /// supports (a subset of `known_terminal`). Absent in older payloads, which read as false.
    #[serde(default)]
    pub paste_terminal: bool,
    /// Bundle path of the paste terminal (set iff `paste_terminal`). With
    /// `app_pid` it identifies the terminal (the binding itself is `PasteBindingDto`).
    #[serde(default)]
    pub paste_app: Option<String>,
    pub reason: Option<String>,
}

/// The paste terminal that was in front when dictation started: its pid and
/// app bundle path. Mirrors TypeScript `PasteBinding`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteBindingDto {
    pub app_pid: i32,
    pub paste_app: String,
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
            known_terminal: false,
            paste_terminal: false,
            paste_app: None,
            reason: Some(reason.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_without_known_terminal_reads_as_false() {
        let older = r#"{"appName":"Notes","appPid":7,"capturedAt":1,"elementId":null,
            "elementRole":null,"insertable":false,"kind":"unavailable","reason":null}"#;
        let dto: TargetSnapshotDto = serde_json::from_str(older).unwrap();
        assert!(!dto.known_terminal);
        assert!(!dto.paste_terminal);
        assert_eq!(dto.paste_app, None);
        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["knownTerminal"], false);
        assert_eq!(json["pasteTerminal"], false);
    }
}

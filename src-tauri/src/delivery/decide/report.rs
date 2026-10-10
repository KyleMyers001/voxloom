//! Native insert result surfaced to TypeScript (structured, not message text).

use serde::Serialize;

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InsertReport {
    /// Unicode events posted (not by itself proof of delivery).
    pub typed: bool,
    /// Terminal events posted, NOT confirmation of a CLI input buffer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_dispatch: Option<TerminalDispatch>,
    /// A mutation happened but read-back could not prove the full transcript
    /// landed. Terminal dispatch never auto-copies; other paths retain Copy policy.
    pub unverified: bool,
    /// Diagnostic detail for logs/toasts.
    pub detail: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TerminalDispatch {
    Complete,
    Partial,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_report_serializes_camel_case() {
        let r = InsertReport {
            typed: true,
            unverified: true,
            detail: Some("x".into()),
            ..Default::default()
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["typed"], true);
        assert_eq!(v["unverified"], true);
        assert_eq!(v["detail"], "x");
        assert!(v.get("terminalDispatch").is_none());
        let terminal = InsertReport {
            typed: true,
            unverified: true,
            terminal_dispatch: Some(TerminalDispatch::Complete),
            detail: None,
        };
        let v = serde_json::to_value(&terminal).unwrap();
        assert_eq!(v["terminalDispatch"], "complete");
        assert_eq!(v["unverified"], true);
    }
}

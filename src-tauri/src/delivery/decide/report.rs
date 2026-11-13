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
    /// Set when the BUS-223 ⌘V fallback posted a paste: the clipboard
    /// restore result. `unverified` then says whether read-back proved it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paste: Option<PasteReport>,
}

/// Result of the clipboard paste route. ⌘V was posted; whether the terminal
/// took it is unknown (no AX oracle), so this is never proof of delivery.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PasteReport {
    pub clipboard_restored: bool,
    /// Why the user's prior clipboard was not put back (None when it was).
    pub restore_skipped_reason: Option<String>,
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
            paste: None,
        };
        let v = serde_json::to_value(&terminal).unwrap();
        assert_eq!(v["terminalDispatch"], "complete");
        assert_eq!(v["unverified"], true);
        assert!(v.get("paste").is_none());
        let pasted = InsertReport {
            paste: Some(PasteReport {
                clipboard_restored: true,
                restore_skipped_reason: None,
            }),
            ..Default::default()
        };
        let v = serde_json::to_value(&pasted).unwrap();
        assert_eq!(v["paste"]["clipboardRestored"], true);
        assert_eq!(v["unverified"], false);
    }

    #[test]
    fn paste_report_serializes_camel_case() {
        let r = PasteReport {
            clipboard_restored: false,
            restore_skipped_reason: Some("why".into()),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["clipboardRestored"], false);
        assert_eq!(v["restoreSkippedReason"], "why");
    }
}

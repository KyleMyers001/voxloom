//! Native insert result surfaced to TypeScript (structured, not message text).

use serde::Serialize;

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InsertReport {
    /// Delivered by Unicode key events (web field ignored AXSelectedText).
    pub typed: bool,
    /// A mutation happened but read-back could not prove the full transcript
    /// landed: text may be (partially) in the field. TS copies and says so.
    pub unverified: bool,
    /// Diagnostic detail for logs/toasts.
    pub detail: Option<String>,
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
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["typed"], true);
        assert_eq!(v["unverified"], true);
        assert_eq!(v["detail"], "x");
    }
}

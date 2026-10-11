//! Insert into an editable, non-secure text element whose AXValue cannot be
//! read (e.g. Apple Messages). One AXSelectedText write, then verify by
//! `AXNumberOfCharacters`; otherwise report Unverified (TS: "May have been
//! inserted — also copied"). The caller has already refused secure fields.

use super::ax::{copy_i64_attr, copy_string_attr, set_ax_string, AXUIElementRef};
use crate::delivery::decide::length::after_ax_by_length;
use crate::delivery::decide::{AfterAx, InsertReport};

fn utf16_len(s: &str) -> i64 {
    s.encode_utf16().count() as i64
}

pub fn insert_without_value(element: AXUIElementRef, text: &str) -> Result<InsertReport, String> {
    let before = copy_i64_attr(element, "AXNumberOfCharacters");
    let selected = copy_string_attr(element, "AXSelectedText").map(|s| utf16_len(&s));
    let ax = set_ax_string(element, "AXSelectedText", text);
    let after = copy_i64_attr(element, "AXNumberOfCharacters");
    match after_ax_by_length(ax, before, selected, after, utf16_len(text)) {
        AfterAx::Inserted => Ok(InsertReport {
            detail: Some("verified by character count (AXValue unreadable)".into()),
            ..Default::default()
        }),
        AfterAx::Failed(err) => Err(err),
        AfterAx::Unverified | AfterAx::TypeFallback => Ok(InsertReport {
            unverified: true,
            detail: Some("AXValue unreadable; insert could not be verified".into()),
            ..Default::default()
        }),
    }
}

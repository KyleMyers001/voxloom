//! Caret-aware AXSelectedText insert with exact read-back, the guarded
//! Chromium/Electron retry (`decide::retry`), and verified Unicode typing
//! for unchanged web fields.

use super::ax::{ancestor_roles, copy_string_attr, set_ax_string, AXUIElementRef};
use super::{focus_still_matches, host, typing, web_ax};
use crate::delivery::decide::retry::{retry_eligible, retry_once, RetryIo};
use crate::delivery::decide::{
    after_ax, is_web_content_field, value_confirms_insert, AfterAx, InsertReport,
};
use crate::delivery::types::TargetSnapshotDto;

/// Real AX side effects for the retry.
struct AxRetry<'a> {
    element: AXUIElementRef,
    validated: &'a TargetSnapshotDto,
    text: &'a str,
}

impl RetryIo for AxRetry<'_> {
    fn reassert(&mut self) {
        web_ax::reassert(self.validated.app_pid);
    }
    fn sleep(&mut self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
    fn read(&mut self) -> Option<String> {
        copy_string_attr(self.element, "AXValue")
    }
    fn write(&mut self) -> Result<(), String> {
        focus_still_matches(self.validated)?;
        insert_selected_text_with(self.text, |a, t| set_ax_string(self.element, a, t))
    }
}

pub fn insert_selected(
    element: AXUIElementRef,
    validated: &TargetSnapshotDto,
    before: String,
    text: &str,
) -> Result<InsertReport, String> {
    let ax = insert_selected_text_with(text, |a, t| set_ax_string(element, a, t));
    let after = copy_string_attr(element, "AXValue");
    let role = validated.element_role.clone().unwrap_or_default();
    let has_dom_id = copy_string_attr(element, "AXDOMIdentifier").is_some();
    // Skip the parent walk when the DOM id already proves web content.
    let ancestors = if has_dom_id {
        Vec::new()
    } else {
        ancestor_roles(element)
    };
    // Type only into web fields of hosts known to honor Unicode events.
    let may_type = is_web_content_field(&role, has_dom_id, &ancestors)
        && validated.app_pid.is_some_and(host::unicode_typing_ok);
    let mut outcome = after_ax(may_type, ax.clone(), &before, after.as_deref(), text);
    // Chromium/Electron may have dropped web AX while idle (the tree is then
    // partial, so may_type is false and we land here, not in TypeFallback).
    let web_host = validated
        .app_pid
        .and_then(host::web_ax_activation)
        .is_some();
    if retry_eligible(&ax, &outcome, web_host) {
        let mut io = AxRetry {
            element,
            validated,
            text,
        };
        outcome = retry_once(&ax, &before, text, &mut io);
    }
    match outcome {
        AfterAx::Inserted => Ok(InsertReport::default()),
        AfterAx::Failed(err) => Err(err),
        AfterAx::Unverified => unverified(
            false,
            "AX write changed the field but could not be verified".into(),
        ),
        AfterAx::TypeFallback => {
            let (posted, typed) = typing::type_text(
                text,
                || focus_still_matches(validated),
                |so_far| wait_for_insert(element, &before, so_far),
            );
            match typed {
                Err(err) if posted == 0 => Err(err),
                Err(err) => unverified(true, format!("{err} (partially typed)")),
                Ok(()) => Ok(InsertReport {
                    typed: true,
                    ..Default::default()
                }),
            }
        }
    }
}

/// Poll read-back briefly: typed key events are processed asynchronously.
fn wait_for_insert(element: AXUIElementRef, before: &str, text: &str) -> bool {
    for _ in 0..30 {
        if let Some(after) = copy_string_attr(element, "AXValue") {
            if value_confirms_insert(before, &after, text) {
                return true;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    false
}

fn unverified(typed: bool, detail: String) -> Result<InsertReport, String> {
    Ok(InsertReport {
        typed,
        unverified: true,
        detail: Some(detail),
        ..Default::default()
    })
}

fn insert_selected_text_with(
    text: &str,
    set: impl FnOnce(&str, &str) -> Result<(), String>,
) -> Result<(), String> {
    // AXValue replaces the entire field; a failed selected-text set must not
    // try another AX mutation. The caller will use the Copy/Failed policy.
    set("AXSelectedText", text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_text_failure_never_attempts_value_write() {
        let mut attrs = Vec::new();
        let result = insert_selected_text_with("dictation", |attr, text| {
            attrs.push((attr.to_string(), text.to_string()));
            Err("AX set failed".into())
        });
        assert!(result.is_err());
        assert_eq!(attrs, [("AXSelectedText".into(), "dictation".into())]);
    }
}

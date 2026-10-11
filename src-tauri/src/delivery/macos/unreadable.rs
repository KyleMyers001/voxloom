//! Apple Messages only (allowlisted in `decide::messages`): insert into a
//! non-secure text element whose AXValue cannot be read. AXSelectedText first,
//! then (if ignored) guarded Unicode typing, both verified by
//! `AXNumberOfCharacters`. The caller has already refused secure fields.

use super::ax::{copy_i64_attr, copy_string_attr, set_ax_string, AXUIElementRef};
use super::{focus_still_matches, typing};
use crate::delivery::decide::messages::{
    insert_unreadable, typed_count_ok, UnreadableIo, UnreadableOutcome, COUNT_POLLS, COUNT_POLL_MS,
};
use crate::delivery::decide::{AfterAx, InsertReport};
use crate::delivery::types::TargetSnapshotDto;

fn utf16_len(s: &str) -> i64 {
    s.encode_utf16().count() as i64
}

fn sleep_ms(ms: u64) {
    std::thread::sleep(std::time::Duration::from_millis(ms));
}

struct AxCounts<'a> {
    element: AXUIElementRef,
    validated: &'a TargetSnapshotDto,
    text: &'a str,
}

impl UnreadableIo for AxCounts<'_> {
    fn count(&mut self) -> Option<i64> {
        copy_i64_attr(self.element, "AXNumberOfCharacters")
    }
    fn selected_len(&mut self) -> Option<i64> {
        copy_string_attr(self.element, "AXSelectedText").map(|s| utf16_len(&s))
    }
    fn sleep(&mut self, ms: u64) {
        sleep_ms(ms);
    }
    fn write_ax(&mut self) -> Result<(), String> {
        set_ax_string(self.element, "AXSelectedText", self.text)
    }
    fn type_verified(&mut self, before: i64, selected: i64) -> (usize, Result<(), String>) {
        let element = self.element;
        typing::type_text(
            self.text,
            || focus_still_matches(self.validated),
            |so_far| {
                // Key events are processed asynchronously: poll briefly.
                (0..COUNT_POLLS).any(|i| {
                    if i > 0 {
                        sleep_ms(COUNT_POLL_MS);
                    }
                    let now = copy_i64_attr(element, "AXNumberOfCharacters");
                    typed_count_ok(before, selected, now, utf16_len(so_far))
                })
            },
        )
    }
}

fn unverified(typed: bool, detail: &str) -> Result<InsertReport, String> {
    Ok(InsertReport {
        typed,
        unverified: true,
        detail: Some(detail.into()),
        ..Default::default()
    })
}

pub fn insert_without_value(
    element: AXUIElementRef,
    validated: &TargetSnapshotDto,
    text: &str,
) -> Result<InsertReport, String> {
    let mut io = AxCounts {
        element,
        validated,
        text,
    };
    match insert_unreadable(&mut io, utf16_len(text), true) {
        UnreadableOutcome::Ax(AfterAx::Inserted) => Ok(InsertReport {
            detail: Some("verified by character count (AXValue unreadable)".into()),
            ..Default::default()
        }),
        UnreadableOutcome::Ax(AfterAx::Failed(err)) => Err(err),
        UnreadableOutcome::Ax(_) => {
            unverified(false, "AXValue unreadable; insert could not be verified")
        }
        UnreadableOutcome::Typed(_, Ok(())) => Ok(InsertReport {
            typed: true,
            detail: Some("typed; verified by character count (AXValue unreadable)".into()),
            ..Default::default()
        }),
        UnreadableOutcome::Typed(0, Err(err)) => Err(err),
        UnreadableOutcome::Typed(_, Err(err)) => {
            unverified(true, &format!("{err} (partially typed)"))
        }
    }
}

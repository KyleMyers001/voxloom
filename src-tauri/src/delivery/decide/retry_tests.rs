use super::*;
use std::cell::{Cell, RefCell};

/// A fake field: `value` is what AXValue reads back.
struct Field {
    value: RefCell<String>,
    writes: Cell<u32>,
    reasserts: Cell<u32>,
}

impl Field {
    fn new(v: &str) -> Self {
        Self {
            value: RefCell::new(v.into()),
            writes: Cell::new(0),
            reasserts: Cell::new(0),
        }
    }
    fn read(&self) -> Option<String> {
        Some(self.value.borrow().clone())
    }
}

#[test]
fn retry_succeeds_after_reassert() {
    let f = Field::new("Hi ");
    let r = retry_once(
        "Hi ",
        "there",
        || f.reasserts.set(f.reasserts.get() + 1),
        || f.read(),
        || {
            f.writes.set(f.writes.get() + 1);
            f.value.borrow_mut().push_str("there");
            Ok(())
        },
    );
    assert_eq!(r, AfterAx::Inserted);
    assert_eq!((f.reasserts.get(), f.writes.get()), (1, 1));
}

#[test]
fn late_landing_first_write_is_not_written_twice() {
    // The first write appeared during the settle: re-read proves it.
    let f = Field::new("Hi there");
    let r = retry_once(
        "Hi ",
        "there",
        || {},
        || f.read(),
        || panic!("must not write again"),
    );
    assert_eq!(r, AfterAx::Inserted);
}

#[test]
fn field_changed_otherwise_is_unverified_and_not_written() {
    let f = Field::new("Hi you");
    let r = retry_once(
        "Hi ",
        "there",
        || {},
        || f.read(),
        || panic!("must not write"),
    );
    assert_eq!(r, AfterAx::Unverified);
}

#[test]
fn retry_still_ignored_fails_for_copy_fallback() {
    let f = Field::new("Hi ");
    let r = retry_once("Hi ", "there", || {}, || f.read(), || Ok(()));
    assert_eq!(
        r,
        AfterAx::Failed("AXSelectedText reported success but nothing changed".into())
    );
}

#[test]
fn retry_write_error_is_reported() {
    let f = Field::new("Hi ");
    let r = retry_once(
        "Hi ",
        "there",
        || {},
        || f.read(),
        || Err("insert aborted — target changed".into()),
    );
    assert_eq!(r, AfterAx::Failed("insert aborted — target changed".into()));
}

#[test]
fn unreadable_value_never_writes() {
    let r = retry_once("Hi ", "there", || {}, || None, || panic!("must not write"));
    assert!(matches!(r, AfterAx::Failed(_)));
}

#[test]
fn nbsp_readback_counts_as_unchanged_and_as_inserted() {
    // Chromium contenteditable reports the trailing space as U+00A0.
    let f = Field::new("Hi\u{a0}");
    let r = retry_once(
        "Hi ",
        "there",
        || {},
        || f.read(),
        || {
            *f.value.borrow_mut() = "Hi\u{a0}there".into();
            Ok(())
        },
    );
    assert_eq!(r, AfterAx::Inserted);
}

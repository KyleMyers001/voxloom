use super::*;
use std::collections::VecDeque;

struct Fake {
    counts: VecDeque<Option<i64>>,
    selected: Option<i64>,
    ax: Result<(), String>,
    ax_writes: u32,
    typed: u32,
    type_result: (usize, Result<(), String>),
    slept: Vec<u64>,
}

impl Fake {
    fn new(counts: &[Option<i64>]) -> Self {
        Self {
            counts: counts.iter().copied().collect(),
            selected: Some(0),
            ax: Ok(()),
            ax_writes: 0,
            typed: 0,
            type_result: (1, Ok(())),
            slept: Vec::new(),
        }
    }
}

impl UnreadableIo for Fake {
    fn count(&mut self) -> Option<i64> {
        if self.counts.len() > 1 {
            self.counts.pop_front().unwrap()
        } else {
            self.counts.front().copied().flatten()
        }
    }
    fn selected_len(&mut self) -> Option<i64> {
        self.selected
    }
    fn sleep(&mut self, ms: u64) {
        self.slept.push(ms);
    }
    fn write_ax(&mut self) -> Result<(), String> {
        self.ax_writes += 1;
        self.ax.clone()
    }
    fn type_verified(&mut self, _: i64, _: i64) -> (usize, Result<(), String>) {
        self.typed += 1;
        self.type_result.clone()
    }
}

const TEXT: i64 = 5;

#[test]
fn only_messages_bundle_is_allowlisted() {
    assert!(unreadable_value_allowed(Some("com.apple.MobileSMS")));
    for other in [
        None,
        Some("com.apple.Notes"),
        Some("com.apple.mobilesms"),
        Some("com.google.Chrome"),
        Some("com.tinyspeck.slackmacgap"),
    ] {
        assert!(!unreadable_value_allowed(other), "{other:?}");
    }
}

#[test]
fn ax_write_counted_is_inserted_without_typing() {
    let mut f = Fake::new(&[Some(10), Some(15)]);
    assert_eq!(
        insert_unreadable(&mut f, TEXT, true),
        UnreadableOutcome::Ax(AfterAx::Inserted)
    );
    assert_eq!(f.typed, 0);
}

#[test]
fn count_lag_is_polled_before_any_fallback() {
    let mut counts = vec![Some(10); 8];
    counts.push(Some(15));
    let mut f = Fake::new(&counts);
    assert_eq!(
        insert_unreadable(&mut f, TEXT, true),
        UnreadableOutcome::Ax(AfterAx::Inserted)
    );
    assert_eq!(f.typed, 0);
}

#[test]
fn ignored_ax_write_waits_two_spaced_reads_then_types() {
    // Kyle's Air: Ok, count unchanged => previously "AXSelectedText reported
    // success but nothing changed".
    let mut f = Fake::new(&[Some(10)]);
    assert_eq!(
        insert_unreadable(&mut f, TEXT, true),
        UnreadableOutcome::Typed(1, Ok(()))
    );
    assert_eq!((f.ax_writes, f.typed), (1, 1));
    let tail: Vec<u64> = f.slept.iter().rev().take(2).rev().copied().collect();
    assert_eq!(tail, [150, 300]);
}

#[test]
fn late_ax_landing_during_spaced_reads_never_types() {
    // 1 initial + 30 polls unchanged, then the AX write lands.
    let mut counts = vec![Some(10); 31];
    counts.push(Some(15));
    let mut f = Fake::new(&counts);
    assert_eq!(
        insert_unreadable(&mut f, TEXT, true),
        UnreadableOutcome::Ax(AfterAx::Inserted)
    );
    assert_eq!(f.typed, 0);
    let mut counts = vec![Some(10); 31];
    counts.push(Some(12));
    let mut f = Fake::new(&counts);
    assert_eq!(
        insert_unreadable(&mut f, TEXT, true),
        UnreadableOutcome::Ax(AfterAx::Unverified)
    );
    assert_eq!(f.typed, 0);
}

#[test]
fn no_typing_after_ax_error_or_when_not_allowed() {
    let mut f = Fake::new(&[Some(10)]);
    f.ax = Err("AX set AXSelectedText failed (error -25200)".into());
    assert!(matches!(
        insert_unreadable(&mut f, TEXT, true),
        UnreadableOutcome::Ax(AfterAx::Failed(_))
    ));
    assert_eq!(f.typed, 0);
    let mut f = Fake::new(&[Some(10)]);
    assert_eq!(
        insert_unreadable(&mut f, TEXT, false),
        UnreadableOutcome::Ax(AfterAx::Failed(
            "AXSelectedText reported success but nothing changed".into()
        ))
    );
    assert_eq!(f.typed, 0);
}

#[test]
fn missing_counts_after_ok_write_are_unverified_never_failed_or_typed() {
    let mut f = Fake::new(&[None]);
    assert_eq!(
        insert_unreadable(&mut f, TEXT, true),
        UnreadableOutcome::Ax(AfterAx::Unverified)
    );
    assert_eq!(f.typed, 0);
    let mut f = Fake::new(&[Some(10), None]);
    assert_eq!(
        insert_unreadable(&mut f, TEXT, true),
        UnreadableOutcome::Ax(AfterAx::Unverified)
    );
}

#[test]
fn typed_count_check() {
    assert!(typed_count_ok(10, 0, Some(13), 3));
    assert!(typed_count_ok(10, 4, Some(9), 3));
    assert!(!typed_count_ok(10, 0, Some(10), 3));
    assert!(!typed_count_ok(10, 0, None, 3));
}

use super::*;
use std::collections::VecDeque;

/// Scripted field: `reads` are returned in order (the last one repeats);
/// `on_write` replaces the script after the retry write.
struct Fake {
    reads: VecDeque<Option<String>>,
    on_write: Option<VecDeque<Option<String>>>,
    write_result: Result<(), String>,
    writes: u32,
    reasserts: u32,
    slept: Vec<u64>,
}

fn s(v: &str) -> Option<String> {
    Some(v.into())
}

impl Fake {
    fn new(reads: &[Option<String>]) -> Self {
        Self {
            reads: reads.iter().cloned().collect(),
            on_write: None,
            write_result: Ok(()),
            writes: 0,
            reasserts: 0,
            slept: Vec::new(),
        }
    }
    fn after_write(mut self, reads: &[Option<String>]) -> Self {
        self.on_write = Some(reads.iter().cloned().collect());
        self
    }
}

impl RetryIo for Fake {
    fn reassert(&mut self) {
        self.reasserts += 1;
    }
    fn sleep(&mut self, ms: u64) {
        self.slept.push(ms);
    }
    fn read(&mut self) -> Option<String> {
        if self.reads.len() > 1 {
            self.reads.pop_front().unwrap()
        } else {
            self.reads.front().cloned().flatten()
        }
    }
    fn write(&mut self) -> Result<(), String> {
        self.writes += 1;
        if let Some(next) = self.on_write.take() {
            self.reads = next;
        }
        self.write_result.clone()
    }
}

const OK: Result<(), String> = Ok(());

#[test]
fn retry_requires_two_spaced_unchanged_reads_then_writes_once() {
    let mut f = Fake::new(&[s("Hi ")]).after_write(&[s("Hi there")]);
    assert_eq!(
        retry_once(&OK, "Hi ", "there", &mut f).after,
        AfterAx::Inserted
    );
    assert_eq!((f.reasserts, f.writes), (1, 1));
    assert_eq!(&f.slept[..2], &[150, 300]);
}

#[test]
fn late_landing_on_first_or_second_read_never_writes() {
    for reads in [
        vec![s("Hi there")],
        vec![s("Hi "), s("Hi there")], // landed after the first re-read
    ] {
        let mut f = Fake::new(&reads);
        assert_eq!(
            retry_once(&OK, "Hi ", "there", &mut f).after,
            AfterAx::Inserted
        );
        assert_eq!(f.writes, 0);
    }
}

#[test]
fn late_landing_after_retry_write_is_never_claimed_inserted() {
    // Original write lands right as the retry lands: text twice. Honest Unverified.
    let mut f = Fake::new(&[s("Hi ")]).after_write(&[s("Hi therethere")]);
    assert_eq!(
        retry_once(&OK, "Hi ", "there", &mut f).after,
        AfterAx::Unverified
    );
    assert_eq!(f.writes, 1);
}

#[test]
fn no_retry_after_an_ax_error() {
    let err: Result<(), String> = Err("AX set failed".into());
    let mut f = Fake::new(&[s("Hi ")]);
    assert_eq!(
        retry_once(&err, "Hi ", "there", &mut f).after,
        AfterAx::Failed("AX set failed".into())
    );
    assert_eq!((f.reasserts, f.writes), (0, 0));
    let failed = AfterAx::Failed("x".into());
    assert!(!retry_eligible(&err, &failed, true));
    assert!(retry_eligible(&OK, &failed, true));
    assert!(!retry_eligible(&OK, &failed, false));
    assert!(!retry_eligible(&OK, &AfterAx::Unverified, true));
    assert!(!retry_eligible(&OK, &AfterAx::TypeFallback, true));
}

#[test]
fn retry_readback_lag_is_polled() {
    let mut lag = vec![s("Hi "); 10];
    lag.push(s("Hi there"));
    let mut f = Fake::new(&[s("Hi ")]).after_write(&lag);
    assert_eq!(
        retry_once(&OK, "Hi ", "there", &mut f).after,
        AfterAx::Inserted
    );
    assert_eq!(f.writes, 1);
    assert_eq!(f.slept.iter().filter(|ms| **ms == 20).count(), 10);
}

#[test]
fn field_changed_otherwise_is_unverified_and_not_written() {
    for reads in [vec![s("Hi you")], vec![s("Hi "), s("Hi you")]] {
        let mut f = Fake::new(&reads);
        assert_eq!(
            retry_once(&OK, "Hi ", "there", &mut f).after,
            AfterAx::Unverified
        );
        assert_eq!(f.writes, 0);
    }
}

#[test]
fn retry_still_ignored_fails_for_copy_fallback() {
    let mut f = Fake::new(&[s("Hi ")]);
    assert_eq!(
        retry_once(&OK, "Hi ", "there", &mut f).after,
        AfterAx::Failed("AXSelectedText reported success but nothing changed".into())
    );
    assert_eq!(f.writes, 1);
}

#[test]
fn retry_write_error_is_reported() {
    let mut f = Fake::new(&[s("Hi ")]);
    f.write_result = Err("insert aborted — target changed".into());
    assert_eq!(
        retry_once(&OK, "Hi ", "there", &mut f).after,
        AfterAx::Failed("insert aborted — target changed".into())
    );
}

#[test]
fn unreadable_value_never_writes() {
    let mut f = Fake::new(&[None]);
    assert!(matches!(
        retry_once(&OK, "Hi ", "there", &mut f).after,
        AfterAx::Failed(_)
    ));
    assert_eq!(f.writes, 0);
}

#[test]
fn nbsp_readback_counts_as_unchanged_and_as_inserted() {
    // Chromium contenteditable reports the trailing space as U+00A0.
    let mut f = Fake::new(&[s("Hi\u{a0}")]).after_write(&[s("Hi\u{a0}there")]);
    assert_eq!(
        retry_once(&OK, "Hi ", "there", &mut f).after,
        AfterAx::Inserted
    );
}

fn proven(after: AfterAx) -> RetryOutcome {
    RetryOutcome {
        after,
        proven_unchanged: true,
    }
}

#[test]
fn types_after_retry_only_for_proven_web_field_in_typing_host() {
    let f = || AfterAx::Failed("AXSelectedText reported success but nothing changed".into());
    assert_eq!(
        type_after_retry(proven(f()), true),
        AfterAx::TypeFallback
    );
    assert_eq!(type_after_retry(proven(f()), false), f());
    assert_eq!(type_after_retry(done(f()), true), f());
    assert_eq!(
        type_after_retry(done(AfterAx::Unverified), true),
        AfterAx::Unverified
    );
    assert_eq!(
        type_after_retry(done(AfterAx::Inserted), true),
        AfterAx::Inserted
    );
}

#[test]
fn unreadable_value_before_retry_stays_failed_never_types() {
    let mut f = Fake::new(&[None]);
    let r = retry_once(&OK, "Hi ", "there", &mut f);
    assert!(!r.proven_unchanged);
    assert!(matches!(
        type_after_retry(r, true),
        AfterAx::Failed(_)
    ));
    assert_eq!(f.writes, 0);
}

#[test]
fn unchanged_after_ok_retry_write_is_proven_and_types() {
    let mut f = Fake::new(&[s("Hi ")]);
    let r = retry_once(&OK, "Hi ", "there", &mut f);
    assert!(r.proven_unchanged);
    assert_eq!(type_after_retry(r, true), AfterAx::TypeFallback);
}

#[test]
fn retry_write_error_or_unreadable_readback_never_types() {
    let mut f = Fake::new(&[s("Hi ")]);
    f.write_result = Err("insert aborted — target changed".into());
    let r = retry_once(&OK, "Hi ", "there", &mut f);
    assert!(!r.proven_unchanged);
    assert!(matches!(
        type_after_retry(r, true),
        AfterAx::Failed(_)
    ));
    let mut f = Fake::new(&[s("Hi ")]).after_write(&[None]);
    let r = retry_once(&OK, "Hi ", "there", &mut f);
    assert!(!r.proven_unchanged);
    assert_ne!(type_after_retry(r, true), AfterAx::TypeFallback);
}

#[test]
fn chromium_host_types_when_proven_unchanged_even_if_not_web() {
    let f = AfterAx::Failed("AXSelectedText reported success but nothing changed".into());
    assert_eq!(
        type_after_retry(proven(f), true),
        AfterAx::TypeFallback
    );
}

#[test]
fn chromium_host_not_proven_unchanged_stays_failed() {
    let f = || AfterAx::Failed("AXValue unreadable".into());
    assert_eq!(type_after_retry(done(f()), true), f());
    assert_eq!(type_after_retry(done(f()), true), f());
}

#[test]
fn unrecognised_host_never_types_even_when_proven() {
    let f = || AfterAx::Failed("nothing changed".into());
    assert_eq!(type_after_retry(proven(f()), false), f());
    assert_eq!(type_after_retry(proven(f()), false), f());
}

#[test]
fn reprobe_fails_closed_when_focus_lost_or_unreadable() {
    let f = || AfterAx::Failed("nothing changed".into());
    assert_eq!(reprobe_decision(proven(f()), false, true, true), f());
    assert_eq!(reprobe_decision(proven(f()), true, false, true), f());
    assert_eq!(reprobe_decision(proven(f()), false, false, true), f());
}

#[test]
fn reprobe_types_only_when_proven_unchanged_in_typing_host() {
    let f = || AfterAx::Failed("nothing changed".into());
    assert_eq!(reprobe_decision(proven(f()), true, true, true), AfterAx::TypeFallback);
    assert_eq!(reprobe_decision(proven(f()), true, true, false), f());
    assert_eq!(reprobe_decision(done(f()), true, true, true), f());
    assert_eq!(reprobe_decision(done(AfterAx::Inserted), true, true, true), AfterAx::Inserted);
}

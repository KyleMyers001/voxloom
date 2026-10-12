use super::*;

#[test]
fn readback_accepts_exact_insert_or_selection_replace() {
    assert!(value_confirms_insert("hello", "hello world", " world"));
    assert!(value_confirms_insert("old line", "new line", "new line"));
    assert!(value_confirms_insert("ab", "abb", "b"));
    assert!(value_confirms_insert("", "héllo 👋", "héllo 👋"));
    assert!(value_confirms_insert("say  now", "say hi now", "hi"));
}

#[test]
fn readback_rejects_unchanged_partial_or_transformed() {
    assert!(!value_confirms_insert("hello", "hello", " world"));
    assert!(!value_confirms_insert("hello", "hello!", " world"));
    assert!(!value_confirms_insert("hello", "hello!", ""));
    // Codex P2: old occurrence + truncated write.
    assert!(!value_confirms_insert("hello X", "hello h", "hello"));
    // Hyperion #3: length-limited field accepted one char.
    assert!(!value_confirms_insert("hello X", "hello Xh", "hello"));
    // Autocorrect / reformatting.
    assert!(!value_confirms_insert("", "Hello", "hello"));
}

#[test]
fn after_ax_decisions() {
    let ok = || Ok(());
    assert_eq!(
        after_ax(false, ok(), "a", Some("ab"), "b"),
        AfterAx::Inserted
    );
    assert_eq!(
        after_ax(true, ok(), "a", Some("a"), "b"),
        AfterAx::TypeFallback
    );
    assert_eq!(
        after_ax(true, Err("e".into()), "a", Some("a"), "b"),
        AfterAx::TypeFallback
    );
    // Native fields, or web fields in hosts not known to honor Unicode key
    // events, keep main's fail-closed: no second mutation.
    assert!(matches!(
        after_ax(false, Err("e".into()), "a", Some("a"), "b"),
        AfterAx::Failed(_)
    ));
    assert!(matches!(
        after_ax(false, ok(), "a", Some("a"), "b"),
        AfterAx::Failed(_)
    ));
    // Changed but not provably ours, or unreadable: never retry.
    assert_eq!(
        after_ax(true, ok(), "a", Some("ax"), "b"),
        AfterAx::Unverified
    );
    assert_eq!(after_ax(true, ok(), "a", None, "b"), AfterAx::Unverified);
}

#[test]
fn normalization_folds_nbsp_crlf_and_object_replacement() {
    assert_eq!(normalize_ax_text("a\u{a0}b"), normalize_ax_text("a b"));
    assert_eq!(normalize_ax_text("a\r\nb\rc"), normalize_ax_text("a\nb\nc"));
    assert_eq!(normalize_ax_text("a\u{fffc}b"), normalize_ax_text("ab"));
    // Nothing else is folded.
    assert_ne!(normalize_ax_text("don't"), normalize_ax_text("don’t"));
    assert_ne!(normalize_ax_text("a  b"), normalize_ax_text("a b"));
    assert_ne!(normalize_ax_text("Hi"), normalize_ax_text("hi"));
}

#[test]
fn readback_accepts_chromium_nbsp_and_line_ending_variants() {
    assert!(value_confirms_insert("Hi ", "Hi\u{a0}there", "there"));
    assert!(value_confirms_insert(
        "Hi",
        "Hi there now",
        "\u{a0}there now"
    ));
    assert!(value_confirms_insert("a\r\nb", "a\nb c", " c"));
    assert!(value_confirms_insert("x\u{fffc}y", "x\u{fffc}y z", " z"));
    assert!(value_confirms_insert("x\u{fffc}y", "xy z", " z"));
}

#[test]
fn normalization_does_not_weaken_partial_or_transformed_rejection() {
    assert!(!value_confirms_insert("Hi ", "Hi\u{a0}ther", "there"));
    assert!(!value_confirms_insert("Hi ", "Hi\u{a0}There", "there"));
    assert!(!value_confirms_insert("Hi\u{a0}", "Hi ", "x"));
}

#[test]
fn nbsp_only_difference_counts_as_unchanged() {
    assert_eq!(
        after_ax(true, Ok(()), "Hi ", Some("Hi\u{a0}"), "there"),
        AfterAx::TypeFallback
    );
    assert!(matches!(
        after_ax(false, Ok(()), "Hi ", Some("Hi\u{a0}"), "there"),
        AfterAx::Failed(_)
    ));
}

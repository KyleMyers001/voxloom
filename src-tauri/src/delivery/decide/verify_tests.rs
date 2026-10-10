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
    // Native fields keep main's fail-closed: no second mutation.
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

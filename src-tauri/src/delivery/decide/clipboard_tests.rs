use super::*;

#[test]
fn clipboard_restore_only_when_still_ours() {
    let prior = ClipboardPrior::PlainText("prior".into());
    assert_eq!(
        restore_decision(&prior, Some("dictated"), "dictated"),
        RestoreDecision::Restore("prior".into())
    );
    assert_eq!(
        restore_decision(&prior, Some("user copied"), "dictated"),
        RestoreDecision::Skip("clipboard changed after our write")
    );
    assert!(matches!(
        restore_decision(&prior, None, "d"),
        RestoreDecision::Skip(_)
    ));
    for p in [
        ClipboardPrior::NonText,
        ClipboardPrior::Empty,
        ClipboardPrior::Unreadable,
    ] {
        assert!(matches!(
            restore_decision(&p, Some("d"), "d"),
            RestoreDecision::Skip(_)
        ));
    }
}

#[test]
fn clipboard_classification_never_restores_empty_or_non_text() {
    // Image on clipboard: pbpaste returns "" — must not become Restore("").
    assert_eq!(
        classify_clipboard(Some("«class PNGf», 5120, «class TIFF», 9000"), Some("")),
        ClipboardPrior::NonText
    );
    // Rich text copy from a browser: has HTML/RTF alongside string.
    assert_eq!(
        classify_clipboard(
            Some("«class HTML», 40, «class utf8», 5, string, 5"),
            Some("hello")
        ),
        ClipboardPrior::NonText
    );
    // File copy from Finder.
    assert_eq!(
        classify_clipboard(Some("«class furl», 30, string, 9"), Some("a.txt")),
        ClipboardPrior::NonText
    );
    assert_eq!(
        classify_clipboard(
            Some("«class utf8», 6, «class ut16», 14, string, 6"),
            Some("héllo")
        ),
        ClipboardPrior::PlainText("héllo".into())
    );
    assert_eq!(
        classify_clipboard(Some("string, 0"), Some("")),
        ClipboardPrior::NonText
    );
    assert_eq!(
        classify_clipboard(Some(""), Some("")),
        ClipboardPrior::Empty
    );
    assert_eq!(
        classify_clipboard(None, Some("x")),
        ClipboardPrior::Unreadable
    );
    assert_eq!(
        restore_decision(
            &classify_clipboard(Some("«class PNGf», 1"), Some("")),
            Some("d"),
            "d"
        ),
        RestoreDecision::Skip(
            "clipboard held non-text data (image, file or rich text) that cannot be restored"
        )
    );
}

#[test]
fn insert_report_serializes_camel_case() {
    let r = InsertReport {
        pasted: true,
        clipboard_restored: false,
        restore_skipped_reason: Some("x".into()),
    };
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["restoreSkippedReason"], "x");
    assert_eq!(v["clipboardRestored"], false);
}

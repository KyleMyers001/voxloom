//! Verification for text elements whose AXValue is unreadable (e.g. Apple
//! Messages): compare `AXNumberOfCharacters` before/after one AXSelectedText
//! write. Counts are UTF-16 units, as AX reports them.

use super::verify::AfterAx;

/// `selected_len` is the replaced selection (0 for a caret). Unknown counts
/// never claim Inserted.
pub fn after_ax_by_length(
    ax_result: Result<(), String>,
    before_len: Option<i64>,
    selected_len: Option<i64>,
    after_len: Option<i64>,
    text_len: i64,
) -> AfterAx {
    let (Some(before), Some(after)) = (before_len, after_len) else {
        return match ax_result {
            Err(err) => AfterAx::Failed(err),
            Ok(()) => AfterAx::Unverified,
        };
    };
    let expected = selected_len.map(|sel| before - sel + text_len);
    if after == before && expected != Some(after) {
        return match ax_result {
            Err(err) => AfterAx::Failed(err),
            Ok(()) => AfterAx::Failed("AXSelectedText reported success but nothing changed".into()),
        };
    }
    if after != before && expected == Some(after) {
        return AfterAx::Inserted;
    }
    AfterAx::Unverified
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEXT: i64 = 5; // "hello"

    #[test]
    fn exact_count_at_caret_is_inserted() {
        let r = after_ax_by_length(Ok(()), Some(10), Some(0), Some(15), TEXT);
        assert_eq!(r, AfterAx::Inserted);
    }

    #[test]
    fn exact_count_replacing_a_selection_is_inserted() {
        let r = after_ax_by_length(Ok(()), Some(10), Some(3), Some(12), TEXT);
        assert_eq!(r, AfterAx::Inserted);
    }

    #[test]
    fn unchanged_count_fails_for_copy_fallback() {
        let r = after_ax_by_length(Ok(()), Some(10), Some(0), Some(10), TEXT);
        assert!(matches!(r, AfterAx::Failed(_)));
        let r = after_ax_by_length(
            Err("AX set failed".into()),
            Some(10),
            Some(0),
            Some(10),
            TEXT,
        );
        assert_eq!(r, AfterAx::Failed("AX set failed".into()));
    }

    #[test]
    fn wrong_count_is_unverified_never_inserted() {
        let r = after_ax_by_length(Ok(()), Some(10), Some(0), Some(12), TEXT);
        assert_eq!(r, AfterAx::Unverified);
    }

    #[test]
    fn unknown_counts_are_unverified_or_failed_never_inserted() {
        assert_eq!(
            after_ax_by_length(Ok(()), None, Some(0), None, TEXT),
            AfterAx::Unverified
        );
        assert_eq!(
            after_ax_by_length(Ok(()), Some(10), None, Some(15), TEXT),
            AfterAx::Unverified
        );
        assert!(matches!(
            after_ax_by_length(Err("e".into()), None, None, None, TEXT),
            AfterAx::Failed(_)
        ));
    }

    #[test]
    fn selection_same_length_as_text_is_unverified() {
        // Replacing 5 chars with 5 chars leaves the count unchanged: ambiguous.
        let r = after_ax_by_length(Ok(()), Some(10), Some(5), Some(10), TEXT);
        assert_eq!(r, AfterAx::Unverified);
    }
}

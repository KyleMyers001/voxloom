//! Read-back verification and the post-AX delivery decision.

/// Proof that `after` is exactly `before` with one span (the selection,
/// possibly empty) replaced by the complete `text`. A pre-existing occurrence
/// of `text`, a truncated/partial write, or a transformed write never counts.
pub fn value_confirms_insert(before: &str, after: &str, text: &str) -> bool {
    let (b, a, t): (Vec<char>, Vec<char>, Vec<char>) = (
        before.chars().collect(),
        after.chars().collect(),
        text.chars().collect(),
    );
    if t.is_empty() || a == b || a.len() < t.len() || a.len() > b.len() + t.len() {
        return false;
    }
    let removed = b.len() + t.len() - a.len();
    let prefix = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    (0..=prefix.min(b.len() - removed)).any(|i| {
        a[i..i + t.len()] == t[..] && a[i + t.len()..] == b[i + removed..] && a[..i] == b[..i]
    })
}

/// What to do after the AXSelectedText attempt.
#[derive(Debug, PartialEq, Eq)]
pub enum AfterAx {
    /// Read-back proves the full transcript landed.
    Inserted,
    /// Web field ignored the AX write (value unchanged): type it instead.
    TypeFallback,
    /// AX failed and nothing changed: normal Copy/Failed policy.
    Failed(String),
    /// Something changed but not provably our full text: may be partially in
    /// the field. Never retry another mutation.
    Unverified,
}

pub fn after_ax(
    is_web: bool,
    ax_result: Result<(), String>,
    before: &str,
    after: Option<&str>,
    text: &str,
) -> AfterAx {
    match after {
        Some(after) if value_confirms_insert(before, after, text) => AfterAx::Inserted,
        // Chromium web content often reports AX success (or an error) while
        // leaving the DOM untouched; only then is typing safe.
        Some(after) if after == before && is_web => AfterAx::TypeFallback,
        Some(after) if after == before => match ax_result {
            Err(err) => AfterAx::Failed(err),
            Ok(()) => AfterAx::Failed("AXSelectedText reported success but nothing changed".into()),
        },
        _ => AfterAx::Unverified,
    }
}

#[cfg(test)]
#[path = "verify_tests.rs"]
mod tests;

//! Read-back verification and the post-AX delivery decision.

/// Normalize AX text for comparison only: hosts (notably Chromium
/// contenteditable) report spaces as U+00A0, line breaks as `\r\n`/`\r`, and
/// embeds as U+FFFC. Nothing else is folded, so transformed writes still fail.
pub fn normalize_ax_text(s: &str) -> Vec<char> {
    let mut out = Vec::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{FFFC}' => {}
            '\u{A0}' => out.push(' '),
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push('\n');
            }
            c => out.push(c),
        }
    }
    out
}

/// Equal after `normalize_ax_text`.
pub fn same_ax_text(a: &str, b: &str) -> bool {
    normalize_ax_text(a) == normalize_ax_text(b)
}

/// Proof that `after` is exactly `before` with one span (the selection,
/// possibly empty) replaced by the complete `text`, compared after
/// `normalize_ax_text`. A pre-existing occurrence of `text`, a
/// truncated/partial write, or a transformed write never counts.
pub fn value_confirms_insert(before: &str, after: &str, text: &str) -> bool {
    let (b, a, t) = (
        normalize_ax_text(before),
        normalize_ax_text(after),
        normalize_ax_text(text),
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

/// `may_type`: web field in a host known to honor Unicode key events.
pub fn after_ax(
    may_type: bool,
    ax_result: Result<(), String>,
    before: &str,
    after: Option<&str>,
    text: &str,
) -> AfterAx {
    match after {
        Some(after) if value_confirms_insert(before, after, text) => AfterAx::Inserted,
        // Chromium web content often reports AX success (or an error) while
        // leaving the DOM untouched; only then is typing safe.
        Some(after) if same_ax_text(after, before) && may_type => AfterAx::TypeFallback,
        Some(after) if same_ax_text(after, before) => match ax_result {
            Err(err) => AfterAx::Failed(err),
            Ok(()) => AfterAx::Failed("AXSelectedText reported success but nothing changed".into()),
        },
        _ => AfterAx::Unverified,
    }
}

#[cfg(test)]
#[path = "verify_tests.rs"]
mod tests;

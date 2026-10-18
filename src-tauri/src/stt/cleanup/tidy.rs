//! Repair the text only at the seams where a tag or symbol was removed.
//!
//! Nothing away from a seam is touched: newlines, double spaces, empty
//! brackets, emoticons and leading ellipses elsewhere survive verbatim.

const PUNCT: &[char] = &[',', ';', ':', '.', '!', '?'];
const TERMINAL: &[char] = &['.', '!', '?'];
const HSPACE: &[char] = &[' ', '\t'];

/// Collapse the punctuation meeting at a seam: keep terminal marks if any
/// (so "..." and "?!" survive), otherwise the first mark (",," → ",").
fn collapse_run(run: &str) -> String {
    if run.chars().any(|c| TERMINAL.contains(&c)) {
        run.chars().filter(|c| TERMINAL.contains(c)).collect()
    } else {
        run.chars().next().map(String::from).unwrap_or_default()
    }
}

/// Join text left and right of one removed span.
fn join(left: &str, right: &str) -> String {
    let l = left.trim_end_matches(HSPACE);
    let r = right.trim_start_matches(HSPACE);
    let l_core = l.trim_end_matches(PUNCT);
    let r_after = r.trim_start_matches(PUNCT);
    let (lp, rp) = (&l[l_core.len()..], &r[..r.len() - r_after.len()]);
    let r_core = r_after.trim_start_matches(HSPACE);

    let line_start = l_core.is_empty() || l_core.ends_with('\n');
    let line_end = r_core.is_empty() || r_core.starts_with('\n');
    let attached = r_after.starts_with(|c: char| !c.is_whitespace());
    let punct = if line_start {
        // Orphan punctuation at the start of a line is dropped only when it
        // stands alone; `:)` or `...so` right after the seam is kept.
        if attached {
            rp.to_owned()
        } else {
            String::new()
        }
    } else {
        collapse_run(&format!("{lp}{rp}"))
    };
    let space = if line_start || line_end { "" } else { " " };
    format!("{l_core}{punct}{space}{r_core}")
}

/// Rejoin the pieces returned by `tags::strip_tags`.
pub fn join_pieces(pieces: &[&str]) -> String {
    let mut iter = pieces.iter();
    let mut out = iter.next().map_or_else(String::new, |p| (*p).to_owned());
    for piece in iter {
        out = join(&out, piece);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seam_keeps_newlines() {
        assert_eq!(join("line one\n", " next"), "line one\nnext");
        assert_eq!(join("a", "\n\nb"), "a\n\nb");
    }

    #[test]
    fn seam_collapses_punctuation_only_locally() {
        assert_eq!(join("Done, ", "."), "Done.");
        assert_eq!(join("x,, y,", ", z"), "x,, y, z");
    }
}

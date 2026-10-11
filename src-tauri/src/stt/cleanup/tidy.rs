//! Normalize whitespace and punctuation left behind after stripping.

const PUNCT: &[char] = &[',', ';', ':', '.', '!', '?'];
const TERMINAL: &[char] = &['.', '!', '?'];

/// Collapse a run of adjacent punctuation: keep terminal marks if any
/// (so "..." and "?!" survive), otherwise the first mark (",," → ",").
fn collapse_run(run: &str) -> String {
    if run.chars().any(|c| TERMINAL.contains(&c)) {
        run.chars().filter(|c| TERMINAL.contains(c)).collect()
    } else {
        run.chars().next().map(String::from).unwrap_or_default()
    }
}

/// Collapse whitespace, drop spaces before punctuation, merge orphan
/// punctuation runs, strip leading punctuation and empty brackets.
pub fn tidy(text: &str) -> String {
    let mut s = text.split_whitespace().collect::<Vec<_>>().join(" ");
    for empty in ["()", "[]", "( )", "[ ]"] {
        s = s.replace(empty, " ");
    }
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");

    // Remove whitespace that precedes punctuation.
    let mut no_space = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    for (idx, &c) in chars.iter().enumerate() {
        if c == ' ' && chars.get(idx + 1).is_some_and(|n| PUNCT.contains(n)) {
            continue;
        }
        no_space.push(c);
    }

    // Collapse punctuation runs.
    let mut out = String::with_capacity(no_space.len());
    let mut run = String::new();
    for c in no_space.chars() {
        if PUNCT.contains(&c) {
            run.push(c);
            continue;
        }
        if !run.is_empty() {
            out.push_str(&collapse_run(&run));
            run.clear();
        }
        out.push(c);
    }
    if !run.is_empty() {
        out.push_str(&collapse_run(&run));
    }

    out.trim_start_matches(|c: char| PUNCT.contains(&c) || c.is_whitespace())
        .trim()
        .to_owned()
}

//! BUS-138 PR C: the Whisper initial prompt built from the user's Word
//! dictionary, so recognition leans toward the spellings they saved.
//!
//! Whisper reads at most `n_text_ctx / 2` (224) prompt tokens and silently
//! drops the oldest ones past that. The prompt is capped below it, by the
//! model's own tokenizer, and it is cut at a whole entry, never mid-word.

/// Prompt budget in Whisper tokens (the model keeps 224).
pub const MAX_PROMPT_TOKENS: usize = 220;
/// Entries longer than this are skipped (same limit as the cleanup prompt).
const WORD_MAX_BYTES: usize = 128;
/// The dictionary arrives over IPC; look at this many entries at most.
const MAX_ENTRIES_SCANNED: usize = 256;

/// One entry as it goes into the prompt: trimmed, or `None` when it is empty,
/// too long, or holds a control character (which a prompt cannot carry).
fn usable(entry: &str) -> Option<&str> {
    let word = entry.trim();
    let bad = word.is_empty()
        || word.len() > WORD_MAX_BYTES
        || word
            .chars()
            .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'));
    (!bad).then_some(word)
}

/// Usable entries in saved order, without repeats (case-insensitive).
fn usable_words(dictionary: &[String]) -> Vec<&str> {
    let mut seen = std::collections::HashSet::new();
    dictionary
        .iter()
        .take(MAX_ENTRIES_SCANNED)
        .filter_map(|entry| usable(entry))
        .filter(|word| seen.insert(word.to_lowercase()))
        .collect()
}

/// Word that opens the prompt. A bare list fixed fewer words in the corpus eval.
const LABEL: &str = "Glossary:";

fn render(words: &[&str]) -> String {
    format!("{LABEL} {}.", words.join(", "))
}

/// The prompt for `dictionary`, or `None` when it has no usable entry (then
/// Whisper runs with no prompt at all, as before this feature).
///
/// Entries go in saved order and the first one that would push the prompt past
/// [`MAX_PROMPT_TOKENS`] ends it, so the same dictionary always gives the same
/// prompt. `count_tokens` is the model's tokenizer.
pub fn build_initial_prompt(
    dictionary: &[String],
    count_tokens: impl Fn(&str) -> usize,
) -> Option<String> {
    let mut kept: Vec<&str> = Vec::new();
    for word in usable_words(dictionary) {
        kept.push(word);
        if count_tokens(&render(&kept)) > MAX_PROMPT_TOKENS {
            kept.pop();
            break;
        }
    }
    (!kept.is_empty()).then(|| render(&kept))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stand-in tokenizer: one token per 3 bytes, rounded up.
    fn per_three_bytes(text: &str) -> usize {
        text.len().div_ceil(3)
    }

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|w| (*w).to_owned()).collect()
    }

    fn prompt(list: &[&str]) -> Option<String> {
        build_initial_prompt(&words(list), per_three_bytes)
    }

    #[test]
    fn empty_dictionary_sets_no_prompt() {
        assert_eq!(prompt(&[]), None);
    }

    #[test]
    fn entries_that_cannot_be_used_set_no_prompt() {
        let long = "x".repeat(WORD_MAX_BYTES + 1);
        assert_eq!(
            prompt(&["", "   ", "tab\there", "line\nbreak", &long]),
            None
        );
    }

    #[test]
    fn words_go_in_saved_order() {
        assert_eq!(
            prompt(&["Voxloom", "Notion", "Kubernetes"]).as_deref(),
            Some("Glossary: Voxloom, Notion, Kubernetes.")
        );
    }

    #[test]
    fn skips_blank_unusable_and_repeated_entries() {
        let got = prompt(&[
            " Voxloom ",
            "",
            "voxloom",
            "a\u{2028}b",
            "VOXLOOM",
            "Notion",
        ]);
        assert_eq!(got.as_deref(), Some("Glossary: Voxloom, Notion."));
    }

    #[test]
    fn keeps_the_spelling_as_saved() {
        assert_eq!(
            prompt(&["iPhone", "OAuth"]).as_deref(),
            Some("Glossary: iPhone, OAuth.")
        );
    }

    #[test]
    fn nothing_leaves_the_prompt_over_budget() {
        let many: Vec<String> = (0..200).map(|i| format!("Word{i:03}")).collect();
        let got = build_initial_prompt(&many, per_three_bytes).unwrap();
        assert!(per_three_bytes(&got) <= MAX_PROMPT_TOKENS, "{got}");
        // The next entry would have pushed it over.
        let kept = got.matches(", ").count() + 1;
        let with_next = render(&usable_words(&many[..=kept]));
        assert!(per_three_bytes(&with_next) > MAX_PROMPT_TOKENS);
    }

    #[test]
    fn truncation_cuts_at_a_whole_entry_and_keeps_the_first_ones() {
        let many: Vec<String> = (0..200).map(|i| format!("Word{i:03}")).collect();
        let got = build_initial_prompt(&many, per_three_bytes).unwrap();
        assert!(got.starts_with("Glossary: Word000, Word001, "));
        let last = got.trim_end_matches('.').rsplit(", ").next().unwrap();
        assert_eq!(last.len(), "Word000".len(), "no entry is cut short: {last}");
    }

    #[test]
    fn same_dictionary_same_prompt() {
        let many: Vec<String> = (0..200).map(|i| format!("Word{i:03}")).collect();
        assert_eq!(
            build_initial_prompt(&many, per_three_bytes),
            build_initial_prompt(&many, per_three_bytes)
        );
    }

    #[test]
    fn a_costly_tokenizer_gets_a_shorter_prompt_not_an_overlong_one() {
        // Rare scripts can take one token per byte.
        let per_byte = |text: &str| text.len();
        let many: Vec<String> = (0..50).map(|i| format!("Término{i:02}")).collect();
        let got = build_initial_prompt(&many, per_byte).unwrap();
        assert!(got.len() <= MAX_PROMPT_TOKENS);
        assert!(got.len() < render(&usable_words(&many)).len());
    }

    #[test]
    fn a_first_entry_over_budget_gives_no_prompt() {
        assert_eq!(build_initial_prompt(&words(&["Voxloom"]), |_| 1_000), None);
    }

    #[test]
    fn only_the_first_entries_are_read() {
        let mut many: Vec<String> = vec![String::new(); MAX_ENTRIES_SCANNED];
        many.push("Late".to_owned());
        assert_eq!(usable_words(&many), Vec::<&str>::new());
    }
}

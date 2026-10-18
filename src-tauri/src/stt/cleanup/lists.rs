//! Known Whisper non-speech tags and silence hallucinations (BUS-23).
//!
//! Entries are stored in normalized form (see `normalize_key`): lowercase,
//! `_` → space, whitespace collapsed, trimmed.

/// Inner words of `[...]`, `(...)` or `*...*` that mark a non-speech sound.
/// Anything not on this list (e.g. `(I think)`, `[sic]`) is kept.
pub const SOUND_TAGS: &[&str] = &[
    // High frequency
    "blank audio",
    "silence",
    "music",
    "wind blowing",
    "noise",
    "beep",
    "mumbling",
    // Lower frequency
    "inaudible",
    "applause",
    "laughter",
    "pause",
    "sigh",
    "breathing",
    "sighs",
    "static",
    "laughs",
    "coughs",
    "clicking",
    "keyboard clicking",
];

/// Music symbols stripped outright wherever they appear.
pub const MUSIC_SYMBOLS: &[char] = &['♪', '♫'];

/// Whole-output silence hallucinations. Dropped only when the output is
/// nothing but these phrases AND the clip was quiet.
pub const SILENCE_HALLUCINATIONS: &[&str] = &[
    "thank you",
    "thanks for watching",
    "so",
    "thank you for watching",
    "the",
    "you",
    "oh",
    "okay",
    "i'm sorry",
    "oh my god",
    "bye",
    "subtitles by the amara org community",
];

/// YouTube-style outros removed when they are the final sentence of
/// otherwise real dictation.
pub const TRAILING_OUTROS: &[&str] = &[
    "thanks for watching",
    "thank you for watching",
    "please subscribe",
];

/// Outro prefixes ("subtitles by …") removed as a final sentence.
pub const TRAILING_OUTRO_PREFIXES: &[&str] = &["subtitles by"];

/// Normalize tag inner text for list lookup.
pub fn normalize_key(inner: &str) -> String {
    inner
        .replace('_', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Normalize a sentence/phrase for hallucination lookup: lowercase, curly
/// apostrophes folded, punctuation (except apostrophes) to spaces.
pub fn normalize_phrase(text: &str) -> String {
    let mapped: String = text
        .chars()
        .map(|c| match c {
            '\u{2019}' | '\u{2018}' => '\'',
            c if c.is_alphanumeric() || c == '\'' => c,
            _ => ' ',
        })
        .collect();
    mapped
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub fn is_sound_tag(inner: &str) -> bool {
    let key = normalize_key(inner);
    SOUND_TAGS.contains(&key.as_str())
}

//! BUS-23: strip Whisper non-speech tags and silence hallucinations.
//!
//! Pure text cleanup, run in Rust right after transcription so every
//! delivery path (insert and Copy) and the later LLM cleanup pass (BUS-16)
//! see the same cleaned text. The raw transcript is returned alongside.

mod lists;
mod phrases;
mod tags;
mod tidy;

#[cfg(test)]
mod tests;

/// Why a transcript was reduced to nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DropReason {
    /// RMS gate: the clip was near-silent, whisper was not run.
    SilentAudio,
    /// Voice-activity detection found no speech, whisper was not run.
    NoSpeech,
    /// Only non-speech tags/symbols remained after stripping.
    NonSpeechOnly,
    /// Only a known silence hallucination, and the clip was quiet.
    QuietHallucination,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cleaned {
    pub text: String,
    pub dropped: Option<DropReason>,
}

/// Options for `clean_transcript`.
#[derive(Debug, Clone, Copy)]
pub struct CleanupOptions {
    /// Clip was quiet (low peak/RMS); enables whole-output hallucination drop.
    pub quiet: bool,
    /// Remove trailing YouTube-style outros.
    pub strip_outros: bool,
}

/// Clean raw whisper output. Never removes phrases mid-text.
pub fn clean_transcript(raw: &str, opts: CleanupOptions) -> Cleaned {
    // Tag-free text is never rewritten; seams are repaired only where a
    // tag or symbol was actually removed.
    let stripped = match tags::strip_tags(raw) {
        Some(pieces) => tidy::join_pieces(&pieces),
        None => raw.to_owned(),
    };
    if stripped.trim().is_empty() {
        let dropped = (!raw.trim().is_empty()).then_some(DropReason::NonSpeechOnly);
        return Cleaned {
            text: String::new(),
            dropped,
        };
    }
    if opts.quiet && phrases::is_only_hallucination(&stripped) {
        return Cleaned {
            text: String::new(),
            dropped: Some(DropReason::QuietHallucination),
        };
    }
    let text = if opts.strip_outros {
        phrases::strip_trailing_outros(&stripped)
    } else {
        stripped
    };
    Cleaned {
        text,
        dropped: None,
    }
}

//! BUS-138 PR C: transcription with the user's dictionary as Whisper's initial
//! prompt, plus the guard for Whisper echoing that prompt on a quiet clip.
//!
//! Whisper tends to answer silence or a very short, quiet clip with its own
//! prompt. The silence gate and the tail trim stop most such clips before
//! Whisper runs; this drops what still gets through, the same way a quiet
//! "Thank you." is dropped.

use std::collections::HashSet;
use std::path::Path;

use super::cleanup::DropReason;
use super::engine::{self, TranscriptDto};
use super::error::SttErrorDto;
use super::filter_config::SpeechFilterConfig;
use super::gate::{AudioStats, NoVad};
use super::initial_prompt::{usable_words, LABEL};
use super::pipeline;

fn words_of(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
}

/// True when `text` is made only of dictionary words, which is what an echo
/// of the prompt looks like. Empty text is not an echo.
pub fn echoes_dictionary(text: &str, dictionary: &[String]) -> bool {
    let usable = usable_words(dictionary);
    if usable.is_empty() {
        return false; // no prompt was set, so there is nothing to echo
    }
    let known: HashSet<String> = (usable.into_iter())
        .flat_map(words_of)
        .chain(words_of(LABEL))
        .collect();
    let mut heard = words_of(text).peekable();
    heard.peek().is_some() && heard.all(|w| known.contains(&w))
}

/// Drop the text when the clip was quiet and Whisper only said the dictionary.
/// A loud clip is never touched: saying just "Notion" out loud is dictation.
fn drop_echo(mut out: TranscriptDto, dictionary: &[String], quiet: bool) -> TranscriptDto {
    if quiet && out.dropped.is_none() && echoes_dictionary(&out.text, dictionary) {
        out.text.clear();
        out.dropped = Some(DropReason::QuietHallucination);
    }
    out
}

/// The shipped transcription path (`stt_transcribe`): BUS-23 gates, tail trim,
/// Whisper with the dictionary prompt, cleanup, then the echo guard. An empty
/// dictionary sets no prompt and changes nothing.
pub fn transcribe_with_dictionary(
    model_path: &Path,
    samples: &[f32],
    sample_rate_hz: u32,
    cfg: &SpeechFilterConfig,
    dictionary: &[String],
) -> Result<TranscriptDto, SttErrorDto> {
    let quiet = AudioStats::measure(samples).is_quiet(cfg);
    let out = pipeline::transcribe_filtered(samples, sample_rate_hz, cfg, &NoVad, |pcm| {
        engine::transcribe_pcm(model_path, pcm, sample_rate_hz, cfg, dictionary)
    })?;
    Ok(drop_echo(out, dictionary, quiet))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dictionary() -> Vec<String> {
        ["Voxloom", "Notion", "Open AI"].map(String::from).to_vec()
    }

    fn heard(text: &str) -> TranscriptDto {
        TranscriptDto::raw(text.to_owned(), Some("en".into()))
    }

    #[test]
    fn only_dictionary_words_are_an_echo() {
        let d = dictionary();
        assert!(echoes_dictionary("Voxloom, Notion.", &d));
        assert!(echoes_dictionary("notion voxloom notion", &d));
        assert!(echoes_dictionary("Open AI.", &d));
        assert!(echoes_dictionary("Glossary: Voxloom, Notion.", &d));
        assert!(!echoes_dictionary("Voxloom is down.", &d));
        assert!(!echoes_dictionary("Thank you.", &d));
        assert!(!echoes_dictionary("", &d));
        assert!(!echoes_dictionary("...", &d));
    }

    #[test]
    fn an_empty_dictionary_echoes_nothing() {
        assert!(!echoes_dictionary("Voxloom", &[]));
        assert!(!echoes_dictionary("Glossary", &[]));
    }

    #[test]
    fn a_quiet_echo_is_dropped_like_a_quiet_hallucination() {
        let out = drop_echo(heard("Voxloom, Notion."), &dictionary(), true);
        assert_eq!(out.text, "");
        assert_eq!(out.dropped, Some(DropReason::QuietHallucination));
        assert_eq!(out.raw_text, "Voxloom, Notion.", "raw text is kept");
    }

    #[test]
    fn a_loud_clip_keeps_a_lone_dictionary_word() {
        let out = drop_echo(heard("Notion"), &dictionary(), false);
        assert_eq!(out.text, "Notion");
        assert_eq!(out.dropped, None);
    }

    #[test]
    fn quiet_real_speech_is_kept() {
        let out = drop_echo(heard("Open Notion please."), &dictionary(), true);
        assert_eq!(out.text, "Open Notion please.");
    }

    #[test]
    fn no_dictionary_changes_nothing() {
        let out = drop_echo(heard("Notion"), &[], true);
        assert_eq!(out.text, "Notion");
        assert_eq!(out.dropped, None);
    }

    #[test]
    fn an_earlier_drop_reason_is_not_replaced() {
        let mut out = heard("");
        out.dropped = Some(DropReason::SilentAudio);
        let out = drop_echo(out, &dictionary(), true);
        assert_eq!(out.dropped, Some(DropReason::SilentAudio));
    }

    #[test]
    fn silent_audio_never_reaches_the_engine_with_or_without_a_dictionary() {
        let silent = vec![0.0; 16_000];
        for d in [dictionary(), vec![]] {
            let out = transcribe_with_dictionary(
                Path::new("/nope"),
                &silent,
                16_000,
                &SpeechFilterConfig::default(),
                &d,
            )
            .unwrap();
            assert_eq!(out.dropped, Some(DropReason::SilentAudio));
        }
    }
}

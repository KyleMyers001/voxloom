//! BUS-138 PR C: transcription with the user's dictionary as Whisper's initial
//! prompt, except on quiet clips.
//!
//! With a prompt set, Whisper answers noise and near-silence with different
//! junk than without one ("None!", "q", "exceptional" instead of the empty or
//! "you" output the hallucination filter already knows). So a quiet clip (the
//! same `is_quiet` test the filter uses) runs with no prompt and behaves
//! exactly as it did before this feature. A clip with real speech is louder.

use std::path::Path;

use super::engine::{self, TranscriptDto};
use super::error::SttErrorDto;
use super::filter_config::SpeechFilterConfig;
use super::gate::{AudioStats, NoVad};
use super::pipeline;

/// The dictionary Whisper gets for a clip: none when the clip is quiet.
fn prompt_dictionary(quiet: bool, dictionary: &[String]) -> &[String] {
    if quiet {
        &[]
    } else {
        dictionary
    }
}

/// The shipped transcription path (`stt_transcribe`): BUS-23 gates, tail trim,
/// then Whisper with the dictionary prompt (loud clips only) and cleanup. An
/// empty dictionary sets no prompt and changes nothing.
pub fn transcribe_with_dictionary(
    model_path: &Path,
    samples: &[f32],
    sample_rate_hz: u32,
    cfg: &SpeechFilterConfig,
    dictionary: &[String],
) -> Result<TranscriptDto, SttErrorDto> {
    transcribe_with_dictionary_cancellable(
        model_path,
        samples,
        sample_rate_hz,
        cfg,
        dictionary,
        None,
    )
}

pub(super) fn transcribe_with_dictionary_cancellable(
    model_path: &Path,
    samples: &[f32],
    sample_rate_hz: u32,
    cfg: &SpeechFilterConfig,
    dictionary: &[String],
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> Result<TranscriptDto, SttErrorDto> {
    engine::check_cancelled(cancel)?;
    let quiet = AudioStats::measure(samples).is_quiet(cfg);
    let dictionary = prompt_dictionary(quiet, dictionary);
    let result =
        pipeline::transcribe_filtered(samples, sample_rate_hz, cfg, &NoVad, |pcm| match cancel {
            Some(_) => engine::transcribe_pcm_cancellable(
                model_path,
                pcm,
                sample_rate_hz,
                cfg,
                dictionary,
                cancel,
            ),
            None => engine::transcribe_pcm(model_path, pcm, sample_rate_hz, cfg, dictionary),
        });
    engine::check_cancelled(cancel)?;
    result
}

#[cfg(test)]
mod tests {
    use super::super::cleanup::DropReason;
    use super::*;

    fn dictionary() -> Vec<String> {
        ["Voxloom", "Notion"].map(String::from).to_vec()
    }

    #[test]
    fn a_quiet_clip_gets_no_dictionary() {
        assert!(prompt_dictionary(true, &dictionary()).is_empty());
    }

    #[test]
    fn a_loud_clip_gets_the_whole_dictionary() {
        assert_eq!(prompt_dictionary(false, &dictionary()), &dictionary()[..]);
    }

    #[test]
    fn the_quiet_test_is_the_filters_own() {
        let cfg = SpeechFilterConfig::default();
        let noise = vec![0.005; 16_000];
        let speechlike = vec![0.1; 16_000];
        assert!(AudioStats::measure(&noise).is_quiet(&cfg));
        assert!(!AudioStats::measure(&speechlike).is_quiet(&cfg));
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

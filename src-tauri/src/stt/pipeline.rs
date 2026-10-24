//! BUS-23 transcription pipeline: validate → RMS gate → VAD → quiet-tail
//! trim (BUS-139) → whisper → text cleanup. Runs before delivery so insert
//! and Copy share one result.

use super::cleanup::{clean_transcript, CleanupOptions, DropReason};
use super::engine::{validate_pcm, TranscriptDto};
use super::error::SttErrorDto;
use super::filter_config::SpeechFilterConfig;
use super::gate::{AudioStats, VoiceActivityDetector};
use super::trim::trailing_trim;

fn empty(dropped: DropReason) -> TranscriptDto {
    TranscriptDto {
        text: String::new(),
        language: None,
        raw_text: String::new(),
        dropped: Some(dropped),
    }
}

/// Transcribe with BUS-23 filtering. `engine` runs whisper on the samples
/// (injected so the pipeline is testable without the `whisper` feature).
pub fn transcribe_filtered<F>(
    samples: &[f32],
    sample_rate_hz: u32,
    cfg: &SpeechFilterConfig,
    vad: &dyn VoiceActivityDetector,
    engine: F,
) -> Result<TranscriptDto, SttErrorDto>
where
    F: FnOnce(&[f32]) -> Result<TranscriptDto, SttErrorDto>,
{
    validate_pcm(samples, sample_rate_hz)?;

    let stats = AudioStats::measure(samples);
    if stats.is_silent(cfg) {
        return Ok(empty(DropReason::SilentAudio));
    }
    if cfg.vad && vad.has_speech(samples, sample_rate_hz) == Some(false) {
        return Ok(empty(DropReason::NoSpeech));
    }

    // Whisper hallucinates over a quiet tail; the gates above still judge
    // the whole clip.
    let trim = trailing_trim(samples, sample_rate_hz);
    #[cfg(debug_assertions)]
    eprintln!(
        "[stt] tail trim: tail_rms={:.4} threshold={:.4} trimmed_ms={}",
        trim.tail_rms,
        trim.threshold,
        trim.trimmed_ms(samples.len(), sample_rate_hz)
    );
    let mut out = engine(&samples[..trim.keep_len])?;
    if !cfg.cleanup {
        return Ok(out);
    }
    let cleaned = clean_transcript(
        &out.raw_text,
        CleanupOptions {
            quiet: stats.is_quiet(cfg),
            strip_outros: cfg.strip_trailing_outros,
        },
    );
    out.text = cleaned.text;
    out.dropped = cleaned.dropped;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stt::gate::NoVad;

    struct NoSpeechVad;
    impl VoiceActivityDetector for NoSpeechVad {
        fn has_speech(&self, _: &[f32], _: u32) -> Option<bool> {
            Some(false)
        }
    }

    fn whisper_says(
        text: &'static str,
    ) -> impl FnOnce(&[f32]) -> Result<TranscriptDto, SttErrorDto> {
        move |_| Ok(TranscriptDto::raw(text.to_owned(), Some("en".into())))
    }

    fn never_called(_: &[f32]) -> Result<TranscriptDto, SttErrorDto> {
        panic!("whisper must not run for this clip")
    }

    fn speech() -> Vec<f32> {
        (0..16_000)
            .map(|i| if i % 2 == 0 { 0.3 } else { -0.3 })
            .collect()
    }

    fn quiet() -> Vec<f32> {
        (0..16_000)
            .map(|i| if i % 2 == 0 { 0.004 } else { -0.004 })
            .collect()
    }

    fn run(samples: &[f32], text: &'static str) -> TranscriptDto {
        let cfg = SpeechFilterConfig::default();
        transcribe_filtered(samples, 16_000, &cfg, &NoVad, whisper_says(text)).unwrap()
    }

    #[test]
    fn silent_clip_produces_no_output_and_skips_whisper() {
        let cfg = SpeechFilterConfig::default();
        let out =
            transcribe_filtered(&vec![0.0; 16_000], 16_000, &cfg, &NoVad, never_called).unwrap();
        assert_eq!(out.text, "");
        assert_eq!(out.dropped, Some(DropReason::SilentAudio));
    }

    #[test]
    fn empty_and_wrong_rate_still_error() {
        let cfg = SpeechFilterConfig::default();
        let err = transcribe_filtered(&[], 16_000, &cfg, &NoVad, never_called).unwrap_err();
        assert_eq!(err.code, "unsupported-audio");
        let err = transcribe_filtered(&[0.3], 8_000, &cfg, &NoVad, never_called).unwrap_err();
        assert_eq!(err.code, "unsupported-audio");
    }

    #[test]
    fn vad_veto_only_when_enabled() {
        let mut cfg = SpeechFilterConfig::default();
        let out =
            transcribe_filtered(&speech(), 16_000, &cfg, &NoSpeechVad, whisper_says("hi")).unwrap();
        assert_eq!(out.text, "hi", "VAD disabled by default");

        cfg.vad = true;
        let out = transcribe_filtered(&speech(), 16_000, &cfg, &NoSpeechVad, never_called).unwrap();
        assert_eq!(out.dropped, Some(DropReason::NoSpeech));
        assert_eq!(out.text, "");
    }

    #[test]
    fn cleans_text_and_keeps_raw() {
        let out = run(&speech(), "[Music] Hello there. [BLANK_AUDIO]");
        assert_eq!(out.text, "Hello there.");
        assert_eq!(out.raw_text, "[Music] Hello there. [BLANK_AUDIO]");
        assert_eq!(out.dropped, None);
    }

    #[test]
    fn quiet_hallucination_dropped_loud_kept() {
        let out = run(&quiet(), "Thank you.");
        assert_eq!(out.text, "");
        assert_eq!(out.dropped, Some(DropReason::QuietHallucination));
        assert_eq!(out.raw_text, "Thank you.");

        let out = run(&speech(), "Thank you.");
        assert_eq!(out.text, "Thank you.");
        assert_eq!(out.dropped, None);
    }

    #[test]
    fn tags_only_output_is_dropped() {
        let out = run(&speech(), "[Music] ♪ [Music]");
        assert_eq!(out.text, "");
        assert_eq!(out.dropped, Some(DropReason::NonSpeechOnly));
    }

    #[test]
    fn cleanup_can_be_disabled() {
        let cfg = SpeechFilterConfig {
            cleanup: false,
            ..SpeechFilterConfig::default()
        };
        let out = transcribe_filtered(&speech(), 16_000, &cfg, &NoVad, whisper_says("[Music] hi"))
            .unwrap();
        assert_eq!(out.text, "[Music] hi");
    }

    #[test]
    fn engine_sees_the_clip_without_its_quiet_tail() {
        let cfg = SpeechFilterConfig::default();
        let clip = [speech(), vec![0.0; 32_000]].concat();
        let out = transcribe_filtered(&clip, 16_000, &cfg, &NoVad, |pcm| {
            assert_eq!(pcm.len(), 16_000 + 12_000, "750 ms tail kept");
            Ok(TranscriptDto::raw("hi".into(), Some("en".into())))
        })
        .unwrap();
        assert_eq!(out.text, "hi");
    }

    #[test]
    fn engine_errors_propagate() {
        let cfg = SpeechFilterConfig::default();
        let err = transcribe_filtered(&speech(), 16_000, &cfg, &NoVad, |_| {
            Err(SttErrorDto::new("transcribe-failed", "boom"))
        })
        .unwrap_err();
        assert_eq!(err.code, "transcribe-failed");
    }
}

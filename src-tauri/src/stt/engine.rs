//! Whisper transcription engine.
//!
//! Real whisper.cpp linkage is behind the `whisper` cargo feature so Linux
//! CI on Linux can compile without cmake + ggml. On a Mac, build with
//! `--features whisper` (see README, Local STT).

use super::cleanup::DropReason;
use super::error::SttErrorDto;
use super::filter_config::SpeechFilterConfig;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptDto {
    /// Cleaned text used for insert and Copy (BUS-23).
    pub text: String,
    pub language: Option<String>,
    /// Whisper output before cleanup, kept for debugging / History.
    pub raw_text: String,
    /// Set when cleanup or the upstream gates reduced the output to nothing.
    pub dropped: Option<DropReason>,
}

impl TranscriptDto {
    /// Raw engine output, before BUS-23 cleanup.
    #[cfg_attr(not(any(test, feature = "whisper")), allow(dead_code))]
    pub fn raw(text: String, language: Option<String>) -> Self {
        Self {
            raw_text: text.clone(),
            text,
            language,
            dropped: None,
        }
    }
}

/// Reject buffers whisper cannot accept (empty / not 16 kHz).
pub fn validate_pcm(samples: &[f32], sample_rate_hz: u32) -> Result<(), SttErrorDto> {
    if samples.is_empty() {
        return Err(SttErrorDto::new(
            "unsupported-audio",
            "Audio buffer is empty",
        ));
    }
    if sample_rate_hz != 16_000 {
        return Err(SttErrorDto::new(
            "unsupported-audio",
            format!("Expected 16 kHz PCM, got {sample_rate_hz} Hz"),
        ));
    }
    Ok(())
}

/// Transcribe mono f32 PCM at `sample_rate_hz` using the model at `model_path`.
/// `decode` supplies the whisper.cpp non-speech parameters (BUS-23).
pub fn transcribe_pcm(
    model_path: &std::path::Path,
    samples: &[f32],
    sample_rate_hz: u32,
    decode: &SpeechFilterConfig,
) -> Result<TranscriptDto, SttErrorDto> {
    validate_pcm(samples, sample_rate_hz)?;

    #[cfg(feature = "whisper")]
    {
        transcribe_with_whisper(model_path, samples, decode)
    }

    #[cfg(not(feature = "whisper"))]
    {
        let _ = (model_path, decode);
        Err(SttErrorDto::new(
            "engine-unavailable",
            "Native whisper.cpp is not linked in this build. On macOS rebuild \
             with `--features whisper` after installing cmake (see \
             README, Local STT). Model store / download / buffer \
             handoff still work without that feature.",
        ))
    }
}

#[cfg(feature = "whisper")]
fn transcribe_with_whisper(
    model_path: &std::path::Path,
    samples: &[f32],
    decode: &SpeechFilterConfig,
) -> Result<TranscriptDto, SttErrorDto> {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    let ctx = WhisperContext::new_with_params(
        model_path
            .to_str()
            .ok_or_else(|| SttErrorDto::new("model-missing", "Invalid model path"))?,
        WhisperContextParameters::default(),
    )
    .map_err(|e| SttErrorDto::new("transcribe-failed", format!("load model: {e}")))?;

    let mut state = ctx
        .create_state()
        .map_err(|e| SttErrorDto::new("transcribe-failed", format!("create state: {e}")))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_suppress_non_speech_tokens(decode.suppress_non_speech_tokens);
    params.set_suppress_blank(decode.suppress_blank);
    params.set_no_speech_thold(decode.no_speech_thold);

    state
        .full(params, samples)
        .map_err(|e| SttErrorDto::new("transcribe-failed", format!("full: {e}")))?;

    let n = state
        .full_n_segments()
        .map_err(|e| SttErrorDto::new("transcribe-failed", format!("segments: {e}")))?;

    let mut text = String::new();
    for i in 0..n {
        let segment = state
            .full_get_segment_text(i)
            .map_err(|e| SttErrorDto::new("transcribe-failed", format!("segment text: {e}")))?;
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(segment.trim());
    }

    Ok(TranscriptDto::raw(
        text.trim().to_owned(),
        Some("en".to_owned()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn empty_audio_rejected() {
        let err = transcribe_pcm(
            Path::new("/nope"),
            &[],
            16_000,
            &SpeechFilterConfig::default(),
        )
        .unwrap_err();
        assert_eq!(err.code, "unsupported-audio");
    }

    #[test]
    fn wrong_rate_rejected() {
        let err = transcribe_pcm(
            Path::new("/nope"),
            &[0.1],
            8_000,
            &SpeechFilterConfig::default(),
        )
        .unwrap_err();
        assert_eq!(err.code, "unsupported-audio");
    }

    #[cfg(not(feature = "whisper"))]
    #[test]
    fn without_whisper_feature_reports_engine_unavailable() {
        let err = transcribe_pcm(
            Path::new("/nope"),
            &[0.1, 0.2],
            16_000,
            &SpeechFilterConfig::default(),
        )
        .unwrap_err();
        assert_eq!(err.code, "engine-unavailable");
    }
}

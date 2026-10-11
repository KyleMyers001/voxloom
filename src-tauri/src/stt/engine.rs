//! Whisper transcription engine.
//!
//! Real whisper.cpp linkage is behind the `whisper` cargo feature so Linux
//! CI / this box can compile without cmake + ggml. On Kyle's Mac, build with
//! `--features whisper` (see docs/review/BUS-10-whisper.md).

use super::error::SttErrorDto;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptDto {
    pub text: String,
    pub language: Option<String>,
}

/// Transcribe mono f32 PCM at `sample_rate_hz` using the model at `model_path`.
pub fn transcribe_pcm(
    model_path: &std::path::Path,
    samples: &[f32],
    sample_rate_hz: u32,
) -> Result<TranscriptDto, SttErrorDto> {
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

    #[cfg(feature = "whisper")]
    {
        transcribe_with_whisper(model_path, samples)
    }

    #[cfg(not(feature = "whisper"))]
    {
        let _ = model_path;
        Err(SttErrorDto::new(
            "engine-unavailable",
            "Native whisper.cpp is not linked in this build. On macOS rebuild \
             with `--features whisper` after installing cmake (see \
             docs/review/BUS-10-whisper.md). Model store / download / buffer \
             handoff still work without that feature.",
        ))
    }
}

#[cfg(feature = "whisper")]
fn transcribe_with_whisper(
    model_path: &std::path::Path,
    samples: &[f32],
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

    Ok(TranscriptDto {
        text: text.trim().to_owned(),
        language: Some("en".to_owned()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn empty_audio_rejected() {
        let err = transcribe_pcm(Path::new("/nope"), &[], 16_000).unwrap_err();
        assert_eq!(err.code, "unsupported-audio");
    }

    #[test]
    fn wrong_rate_rejected() {
        let err = transcribe_pcm(Path::new("/nope"), &[0.1], 8_000).unwrap_err();
        assert_eq!(err.code, "unsupported-audio");
    }

    #[cfg(not(feature = "whisper"))]
    #[test]
    fn without_whisper_feature_reports_engine_unavailable() {
        let err = transcribe_pcm(Path::new("/nope"), &[0.1, 0.2], 16_000).unwrap_err();
        assert_eq!(err.code, "engine-unavailable");
    }
}

//! BUS-23 speech-filter configuration. Every field has a default, so the
//! frontend may pass a partial object (or nothing) over IPC.

/// Tunables for the silence gate, hallucination cleanup and whisper decode.
#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SpeechFilterConfig {
    /// Run text cleanup (tags, hallucinations, outros). Raw text is always kept.
    pub cleanup: bool,
    /// Skip whisper when RMS AND peak are below these (≈ −54 / −40 dBFS).
    pub silence_gate_rms: f32,
    pub silence_gate_peak: f32,
    /// "Quiet clip" signal for dropping whole-output hallucinations.
    pub quiet_rms: f32,
    pub quiet_peak: f32,
    /// Remove trailing "thanks for watching" style outros.
    pub strip_trailing_outros: bool,
    /// Consult the voice-activity detector (no backend yet; see `gate`).
    pub vad: bool,
    /// whisper.cpp `suppress_non_speech_tokens`.
    pub suppress_non_speech_tokens: bool,
    /// whisper.cpp `suppress_blank`.
    pub suppress_blank: bool,
    /// whisper.cpp `no_speech_thold`.
    pub no_speech_thold: f32,
}

impl Default for SpeechFilterConfig {
    fn default() -> Self {
        Self {
            cleanup: true,
            silence_gate_rms: 0.002,
            silence_gate_peak: 0.01,
            quiet_rms: 0.01,
            quiet_peak: 0.1,
            strip_trailing_outros: true,
            vad: false,
            suppress_non_speech_tokens: true,
            suppress_blank: true,
            no_speech_thold: 0.6,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_json_fills_defaults() {
        let cfg: SpeechFilterConfig =
            serde_json::from_str(r#"{"noSpeechThold":0.5,"cleanup":false}"#).unwrap();
        assert_eq!(cfg.no_speech_thold, 0.5);
        assert!(!cfg.cleanup);
        assert!(cfg.suppress_non_speech_tokens);
        assert_eq!(cfg.silence_gate_rms, 0.002);
    }

    #[test]
    fn defaults_match_ticket() {
        let cfg = SpeechFilterConfig::default();
        assert!(cfg.suppress_non_speech_tokens && cfg.suppress_blank);
        assert!((cfg.no_speech_thold - 0.6).abs() < f32::EPSILON);
    }
}

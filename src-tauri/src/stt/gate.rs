//! BUS-23 upstream filters: RMS/peak measurement, the silence gate and the
//! voice-activity-detection (VAD) seam.

use super::filter_config::SpeechFilterConfig;

/// Loudness summary of a clip (mono f32, full scale = 1.0).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AudioStats {
    pub peak: f32,
    pub rms: f32,
}

impl AudioStats {
    pub fn measure(samples: &[f32]) -> Self {
        if samples.is_empty() {
            return Self {
                peak: 0.0,
                rms: 0.0,
            };
        }
        let mut peak = 0.0f32;
        let mut sum = 0.0f64;
        for &s in samples {
            peak = peak.max(s.abs());
            sum += f64::from(s) * f64::from(s);
        }
        let rms = (sum / samples.len() as f64).sqrt() as f32;
        Self { peak, rms }
    }

    /// Near-silent: skip whisper entirely (RMS gate).
    pub fn is_silent(&self, cfg: &SpeechFilterConfig) -> bool {
        self.rms < cfg.silence_gate_rms && self.peak < cfg.silence_gate_peak
    }

    /// Quiet: whole-output hallucinations may be dropped.
    pub fn is_quiet(&self, cfg: &SpeechFilterConfig) -> bool {
        self.rms < cfg.quiet_rms && self.peak < cfg.quiet_peak
    }
}

/// Voice-activity detection seam (e.g. Silero VAD).
///
/// `Some(false)` means "confidently no speech" and skips transcription;
/// `None` means "no opinion" and transcription proceeds.
pub trait VoiceActivityDetector: Send + Sync {
    fn has_speech(&self, samples: &[f32], sample_rate_hz: u32) -> Option<bool>;
}

/// Default detector until a real VAD backend lands: never vetoes speech.
pub struct NoVad;

impl VoiceActivityDetector for NoVad {
    fn has_speech(&self, _samples: &[f32], _sample_rate_hz: u32) -> Option<bool> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measure_empty_is_zero() {
        let s = AudioStats::measure(&[]);
        assert_eq!(s.peak, 0.0);
        assert_eq!(s.rms, 0.0);
    }

    #[test]
    fn measure_constant_signal() {
        let s = AudioStats::measure(&[0.5, -0.5, 0.5, -0.5]);
        assert!((s.peak - 0.5).abs() < 1e-6);
        assert!((s.rms - 0.5).abs() < 1e-6);
    }

    #[test]
    fn silent_and_quiet_thresholds() {
        let cfg = SpeechFilterConfig::default();
        let silent = AudioStats::measure(&vec![0.0001; 1600]);
        assert!(silent.is_silent(&cfg));
        assert!(silent.is_quiet(&cfg));

        let quiet = AudioStats::measure(&vec![0.005; 1600]);
        assert!(!quiet.is_silent(&cfg));
        assert!(quiet.is_quiet(&cfg));

        let speech = AudioStats::measure(&vec![0.2; 1600]);
        assert!(!speech.is_silent(&cfg));
        assert!(!speech.is_quiet(&cfg));
    }

    #[test]
    fn a_single_loud_click_is_not_silent() {
        let cfg = SpeechFilterConfig::default();
        let mut samples = vec![0.0; 16_000];
        samples[100] = 0.5;
        assert!(!AudioStats::measure(&samples).is_silent(&cfg));
    }

    #[test]
    fn no_vad_has_no_opinion() {
        assert_eq!(NoVad.has_speech(&[0.0; 10], 16_000), None);
    }
}

/// Native test consumer: takes a normalised CaptureBuffer once, returns
/// content-free metadata (frame count, duration, peak level), and disposes
/// the audio. No audio bytes cross the IPC boundary; no audio is persisted.
use crate::capture::buffer::CaptureBuffer;

/// Content-free metadata from a completed capture test.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TestCaptureMetadata {
    /// Peak absolute amplitude; 0.0 on silence.
    pub peak_level: f32,
    /// Duration of the captured audio.
    pub duration_secs: f64,
    /// True when any sample exceeded the silence threshold.
    pub detected_activity: bool,
    /// Number of captured frames at TARGET_RATE.
    pub frame_count: usize,
}

/// Silence threshold for activity detection (−60 dBFS ≈ 0.001).
const SILENCE_THRESHOLD: f32 = 0.001;

/// Consume the buffer and return metadata. The buffer is dropped afterwards;
/// no audio samples are returned or retained.
pub fn inspect(buffer: CaptureBuffer) -> TestCaptureMetadata {
    let duration_secs = buffer.duration().as_secs_f64();
    let frame_count = buffer.len();
    let samples = buffer.into_samples();

    let peak_level = samples.iter().copied().map(f32::abs).fold(0.0f32, f32::max);

    let detected_activity = peak_level >= SILENCE_THRESHOLD;

    TestCaptureMetadata {
        detected_activity,
        duration_secs,
        frame_count,
        peak_level,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::buffer::{CaptureBuffer, TARGET_RATE};

    fn buffer_with(samples: &[f32]) -> CaptureBuffer {
        let mut b = CaptureBuffer::new();
        b.push(samples).unwrap();
        b
    }

    #[test]
    fn silence_reports_no_activity() {
        let buf = buffer_with(&[0.0, 0.0, 0.0]);
        let meta = inspect(buf);
        assert!(!meta.detected_activity);
        assert_eq!(meta.peak_level, 0.0);
    }

    #[test]
    fn noise_reports_activity_and_peak() {
        let buf = buffer_with(&[0.0, 0.5, -0.8, 0.3]);
        let meta = inspect(buf);
        assert!(meta.detected_activity);
        assert!((meta.peak_level - 0.8).abs() < 1e-6);
    }

    #[test]
    fn below_threshold_is_silent() {
        let buf = buffer_with(&[0.0005, -0.0003]);
        let meta = inspect(buf);
        assert!(!meta.detected_activity);
    }

    #[test]
    fn frame_count_matches_input() {
        let buf = buffer_with(&[0.1, 0.2, 0.3, 0.4]);
        let meta = inspect(buf);
        assert_eq!(meta.frame_count, 4);
    }

    #[test]
    fn duration_matches_frame_count() {
        let samples = vec![0.0f32; TARGET_RATE as usize];
        let buf = buffer_with(&samples);
        let meta = inspect(buf);
        assert!((meta.duration_secs - 1.0).abs() < 1e-9);
    }

    #[test]
    fn empty_buffer_returns_zero_metadata() {
        let buf = CaptureBuffer::new();
        let meta = inspect(buf);
        assert_eq!(meta.frame_count, 0);
        assert_eq!(meta.peak_level, 0.0);
        assert!(!meta.detected_activity);
        assert_eq!(meta.duration_secs, 0.0);
    }
}

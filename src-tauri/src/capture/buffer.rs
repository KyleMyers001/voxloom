/// Bounded mono f32 PCM accumulation buffer.
///
/// Pre-allocated at creation; push rejects once full, returning an overflow
/// error so the caller can end the session cleanly (deposit captured PCM)
/// without blocking or allocating in the real-time callback path.
use std::time::Duration;

/// Target sample rate for normalised capture output.
pub const TARGET_RATE: u32 = 16_000;

/// Maximum capture duration (120-second safety bound).
pub const MAX_DURATION_SECS: u32 = 120;

/// Maximum frames the buffer will hold at TARGET_RATE.
pub const MAX_FRAMES: usize = (TARGET_RATE * MAX_DURATION_SECS) as usize;

#[derive(Debug)]
pub struct CaptureBuffer {
    frames: Vec<f32>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PushError {
    /// Accepting the samples would exceed MAX_FRAMES.
    LimitExceeded,
}

impl CaptureBuffer {
    /// Allocate a buffer with capacity for the full 120-second bound.
    pub fn new() -> Self {
        CaptureBuffer {
            frames: Vec::with_capacity(MAX_FRAMES),
        }
    }

    /// Push normalised mono f32 samples. Returns `Err(LimitExceeded)` if
    /// any sample would push the count past `MAX_FRAMES`.
    pub fn push(&mut self, samples: &[f32]) -> Result<(), PushError> {
        if self.frames.len() + samples.len() > MAX_FRAMES {
            return Err(PushError::LimitExceeded);
        }
        self.frames.extend_from_slice(samples);
        Ok(())
    }

    /// Number of frames currently stored.
    pub fn len(&self) -> usize {
        self.frames.len()
    }

    /// True when no frames have been stored.
    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }

    /// Duration of audio stored at TARGET_RATE.
    pub fn duration(&self) -> Duration {
        Duration::from_secs_f64(
            self.frames.len() as f64 / TARGET_RATE as f64,
        )
    }

    /// Consume the buffer, returning all stored samples.
    pub fn into_samples(self) -> Vec<f32> {
        self.frames
    }
}

impl Default for CaptureBuffer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_accumulates_samples() {
        let mut buf = CaptureBuffer::new();
        buf.push(&[0.1, 0.2, 0.3]).unwrap();
        assert_eq!(buf.len(), 3);
        buf.push(&[0.4]).unwrap();
        assert_eq!(buf.len(), 4);
    }

    #[test]
    fn push_rejects_overflow() {
        let mut buf = CaptureBuffer::new();
        // Fill to exactly MAX_FRAMES.
        let chunk = vec![0.0f32; MAX_FRAMES];
        buf.push(&chunk).unwrap();
        assert_eq!(buf.len(), MAX_FRAMES);
        // One more sample must fail.
        let err = buf.push(&[0.0]).unwrap_err();
        assert_eq!(err, PushError::LimitExceeded);
    }

    #[test]
    fn push_rejects_partial_overflow() {
        let mut buf = CaptureBuffer::new();
        let chunk = vec![0.0f32; MAX_FRAMES - 2];
        buf.push(&chunk).unwrap();
        // 3 samples would exceed capacity even though 2 would fit.
        let err = buf.push(&[0.0, 0.0, 0.0]).unwrap_err();
        assert_eq!(err, PushError::LimitExceeded);
    }

    #[test]
    fn duration_is_exact_at_target_rate() {
        let mut buf = CaptureBuffer::new();
        buf.push(&vec![0.0f32; TARGET_RATE as usize]).unwrap();
        let d = buf.duration();
        // Allow sub-millisecond float rounding.
        assert!((d.as_secs_f64() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn is_empty_initially() {
        let buf = CaptureBuffer::new();
        assert!(buf.is_empty());
    }

    #[test]
    fn into_samples_consumes_frames() {
        let mut buf = CaptureBuffer::new();
        buf.push(&[1.0, 2.0]).unwrap();
        let samples = buf.into_samples();
        assert_eq!(samples, vec![1.0f32, 2.0]);
    }
}

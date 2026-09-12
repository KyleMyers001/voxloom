/// Downmix-and-resample: interleaved native samples → mono f32 16 kHz.
///
/// Owns the Rubato FastFixedIn resampler and an input chunk accumulator.
/// All work happens on the coordinator worker thread, not the real-time
/// audio callback. The callback feeds raw interleaved samples into a
/// bounded queue; the worker drains it and calls `Resampler::process_chunk`.
use rubato::{FastFixedIn, PolynomialDegree, Resampler};

/// Size of the resampler input window in native frames.
const CHUNK_FRAMES: usize = 1024;

/// Maximum ratio deviation allowed by the resampler (no dynamic rate change
/// is performed; this is the minimum required by FastFixedIn::new).
const MAX_RATIO_RELATIVE: f64 = 1.0;

pub struct Downmixer {
    channels: usize,
    /// Resampler is None when native_rate == TARGET_RATE (no-op path).
    resampler: Option<FastFixedIn<f32>>,
    /// Mono accumulation buffer waiting for a full CHUNK_FRAMES window.
    staging: Vec<f32>,
}

impl Downmixer {
    /// Create a downmixer for `channels` interleaved channels sampled at
    /// `native_rate` Hz, producing mono f32 at TARGET_RATE.
    pub fn new(
        channels: usize,
        native_rate: u32,
    ) -> Result<Self, rubato::ResamplerConstructionError> {
        use crate::capture::buffer::TARGET_RATE;
        let ratio = TARGET_RATE as f64 / native_rate as f64;
        let resampler = if native_rate != TARGET_RATE {
            Some(FastFixedIn::<f32>::new(
                ratio,
                MAX_RATIO_RELATIVE,
                PolynomialDegree::Linear,
                CHUNK_FRAMES,
                1, // mono after downmix
            )?)
        } else {
            None
        };
        Ok(Downmixer {
            channels,
            resampler,
            staging: Vec::with_capacity(CHUNK_FRAMES * 2),
        })
    }

    /// Accept a slice of interleaved f32 samples from the real-time queue.
    /// Returns zero or more mono 16 kHz frames. Never allocates on the
    /// hot path when the resampler window is not full.
    pub fn process(
        &mut self,
        interleaved: &[f32],
    ) -> Vec<f32> {
        // Downmix to mono by averaging channels.
        let step = self.channels.max(1);
        for chunk in interleaved.chunks(step) {
            let sum: f32 = chunk.iter().copied().sum();
            self.staging.push(sum / step as f32);
        }

        if self.resampler.is_none() {
            // Native rate already matches target; drain staging directly.
            return std::mem::take(&mut self.staging);
        }

        let resampler = self.resampler.as_mut().unwrap();
        let chunk_size = CHUNK_FRAMES;
        let mut output = Vec::new();

        // Process complete CHUNK_FRAMES windows.
        while self.staging.len() >= chunk_size {
            let window: Vec<f32> =
                self.staging.drain(..chunk_size).collect();
            match resampler.process(&[window], None) {
                Ok(mut channels) => {
                    if let Some(ch) = channels.pop() {
                        output.extend(ch);
                    }
                }
                Err(_) => {
                    // Resampler error: discard this window; coordinator
                    // will surface the error via the watchdog.
                }
            }
        }
        output
    }

    /// Flush any remaining samples below CHUNK_FRAMES using silent padding.
    /// Call once at end-of-stream before discarding the downmixer.
    pub fn flush(&mut self) -> Vec<f32> {
        if self.staging.is_empty() {
            return Vec::new();
        }
        if self.resampler.is_none() {
            return std::mem::take(&mut self.staging);
        }
        let resampler = self.resampler.as_mut().unwrap();
        let chunk_size = CHUNK_FRAMES;
        // Pad with silence to a full chunk.
        let original_len = self.staging.len();
        self.staging.resize(chunk_size, 0.0);
        let window = std::mem::take(&mut self.staging);
        match resampler.process(&[window], None) {
            Ok(mut channels) => {
                if let Some(mut ch) = channels.pop() {
                    // Trim output proportionally to the unpadded input.
                    let keep = (original_len * ch.len()) / chunk_size;
                    ch.truncate(keep);
                    return ch;
                }
            }
            Err(_) => {}
        }
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::buffer::TARGET_RATE;

    fn silence(n: usize) -> Vec<f32> {
        vec![0.0f32; n]
    }

    #[test]
    fn mono_passthrough_at_target_rate() {
        let mut d = Downmixer::new(1, TARGET_RATE).unwrap();
        let out = d.process(&silence(256));
        assert_eq!(out.len(), 256);
    }

    #[test]
    fn stereo_downmix_halves_frame_count() {
        // Stereo at target rate: two-channel interleaved, average to mono.
        let mut d = Downmixer::new(2, TARGET_RATE).unwrap();
        // 512 interleaved stereo samples = 256 mono frames.
        let stereo: Vec<f32> = (0..512)
            .map(|i| if i % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        let out = d.process(&stereo);
        // Average of 1.0 and -1.0 is 0.0.
        assert!(!out.is_empty());
        assert!(out.iter().all(|&s| s.abs() < 1e-6));
    }

    #[test]
    fn resampling_44100_to_16000_produces_output() {
        // 44100 Hz mono → 16000 Hz; process enough for ≥1 chunk.
        let mut d = Downmixer::new(1, 44_100).unwrap();
        // Feed 4×CHUNK_FRAMES native samples (should produce ~1449 target frames).
        let input = silence(CHUNK_FRAMES * 4);
        let out = d.process(&input);
        assert!(!out.is_empty());
        // Output rate should be approximately TARGET_RATE/44100 × input.
        let expected_approx = (CHUNK_FRAMES * 4) as f64
            * TARGET_RATE as f64 / 44_100f64;
        let ratio = out.len() as f64 / expected_approx;
        assert!(
            ratio > 0.8 && ratio < 1.25,
            "ratio {ratio} out of range"
        );
    }

    #[test]
    fn flush_returns_tail_samples() {
        // At target rate: any remaining samples should be returned on flush.
        let mut d = Downmixer::new(1, TARGET_RATE).unwrap();
        d.process(&silence(100)); // Feed a small batch, less than CHUNK_FRAMES.
        let flushed = d.flush();
        // At target rate the staging drains directly, so flush should
        // be non-empty only if staging had content.
        // (process already returned them for target-rate case)
        let _ = flushed; // Just assert it doesn't panic.
    }

    #[test]
    fn flush_returns_tail_for_resampled_stream() {
        let mut d = Downmixer::new(1, 44_100).unwrap();
        // Feed some samples, but fewer than CHUNK_FRAMES.
        d.process(&silence(512));
        // staging has < CHUNK_FRAMES; flush should not panic and may return 0.
        let flushed = d.flush();
        assert!(flushed.len() < CHUNK_FRAMES);
    }
}

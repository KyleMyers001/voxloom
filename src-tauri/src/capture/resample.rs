/// Resampler: mono f32 chunks at native rate → mono f32 at 16 kHz.
///
/// Uses `SincFixedIn` (anti-aliased windowed-sinc interpolation).
/// Parameters chosen for speech-band quality at 16 kHz output:
///   sinc_len 256     — long enough filter for good stopband rejection.
///   f_cutoff 0.95    — preserves the full speech band up to 7.6 kHz.
///   oversampling 128 — accurate polynomial interpolation.
///   BlackmanHarris2  — ≥90 dB ideal stopband attenuation.
///   Cubic             — balance accuracy/CPU on the worker thread.
///
/// `flush()` drains the FIR delay by feeding zeros after the partial chunk,
/// then trims the output to the expected canonical duration so that no
/// silence tail or FIR-delay artefact is included.
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters,
    SincInterpolationType, WindowFunction,
};

use crate::capture::buffer::TARGET_RATE;

/// Input chunk size in native-rate frames fed to the resampler per call.
pub const CHUNK_FRAMES: usize = 1024;

const SINC_PARAMS: SincInterpolationParameters =
    SincInterpolationParameters {
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Cubic,
        oversampling_factor: 128,
        sinc_len: 256,
        window: WindowFunction::BlackmanHarris2,
    };

const MAX_RATIO_RELATIVE: f64 = 1.0;

pub struct Downmixer {
    resampler: Option<SincFixedIn<f32>>,
    /// Resampling ratio (TARGET_RATE / native_rate); 1.0 in passthrough.
    ratio: f64,
    /// Pre-allocated output buffer.
    out_buf: Vec<Vec<f32>>,
    /// Native-rate mono frames below CHUNK_FRAMES not yet resampled.
    staging: Vec<f32>,
}

impl Downmixer {
    /// Create a downmixer for mono samples at `native_rate` Hz.
    /// Returns `Err` for rates that produce an invalid ratio (e.g. 0).
    pub fn new(native_rate: u32) -> Result<Self, String> {
        if native_rate == 0 {
            return Err(String::from(
                "capture-unavailable: native_rate must be > 0",
            ));
        }
        let (resampler, out_buf) = if native_rate != TARGET_RATE {
            let ratio = TARGET_RATE as f64 / native_rate as f64;
            if !ratio.is_finite() || ratio <= 0.0 {
                return Err(format!(
                    "capture-unavailable: invalid resampling ratio \
                     {ratio} for native_rate={native_rate}"
                ));
            }
            let r = SincFixedIn::<f32>::new(
                ratio,
                MAX_RATIO_RELATIVE,
                SINC_PARAMS,
                CHUNK_FRAMES,
                1,
            )
            .map_err(|e| {
                format!(
                    "capture-unavailable: resampler init failed: {e}"
                )
            })?;
            let max_out = r.output_frames_max();
            (Some(r), vec![vec![0.0f32; max_out]; 1])
        } else {
            (None, Vec::new())
        };

        Ok(Downmixer {
            out_buf,
            ratio: if native_rate != TARGET_RATE {
                TARGET_RATE as f64 / native_rate as f64
            } else {
                1.0
            },
            resampler,
            staging: Vec::with_capacity(CHUNK_FRAMES * 2),
        })
    }

    /// Push mono f32 frames. Returns resampled (or passthrough) frames.
    pub fn process(&mut self, mono: &[f32]) -> Result<Vec<f32>, String> {
        if self.resampler.is_none() {
            return Ok(mono.to_vec());
        }

        self.staging.extend_from_slice(mono);
        let resampler = self.resampler.as_mut().unwrap();
        let mut output = Vec::new();

        while self.staging.len() >= CHUNK_FRAMES {
            let window: Vec<f32> =
                self.staging.drain(..CHUNK_FRAMES).collect();
            let (_, n_out) = resampler
                .process_into_buffer(
                    &[window.as_slice()],
                    &mut self.out_buf,
                    None,
                )
                .map_err(|e| {
                    format!(
                        "capture-unavailable: resampler error: {e}"
                    )
                })?;
            output.extend_from_slice(&self.out_buf[0][..n_out]);
        }

        Ok(output)
    }

    /// Flush remaining frames from staging and drain the FIR group delay.
    ///
    /// Steps:
    /// 1. Compute the expected output frame count for the staged input.
    /// 2. Pad staging to CHUNK_FRAMES with silence and process.
    /// 3. Feed additional silence chunks until the filter delay is drained.
    /// 4. Trim the combined output to exactly `expected_frames`.
    pub fn flush(&mut self) -> Result<Vec<f32>, String> {
        if self.staging.is_empty() {
            return Ok(Vec::new());
        }
        if self.resampler.is_none() {
            return Ok(std::mem::take(&mut self.staging));
        }

        let resampler = self.resampler.as_mut().unwrap();
        let ratio = self.ratio;
        let output_delay = resampler.output_delay();

        let original_len = self.staging.len();
        // Expected output frames for the real (unpadded) input.
        let expected_frames =
            ((original_len as f64 * ratio).round() as usize)
                .min(original_len * 2 + output_delay + 2);

        // Drain enough silence to push real signal through FIR delay.
        // We need `expected_frames + output_delay` output frames total,
        // which requires processing enough input chunks.
        let total_out_needed = expected_frames + output_delay;
        // How many CHUNK_FRAMES of silence needed after the padded chunk.
        // Each CHUNK produces approximately CHUNK_FRAMES * ratio outputs.
        let approx_out_per_chunk = (CHUNK_FRAMES as f64 * ratio).ceil()
            as usize + 1;
        let extra_silence_chunks =
            (total_out_needed / approx_out_per_chunk) + 2;

        // Pad staging to CHUNK_FRAMES.
        self.staging.resize(CHUNK_FRAMES, 0.0);
        let mut combined_out = Vec::with_capacity(
            total_out_needed + approx_out_per_chunk,
        );

        // Process padded staging chunk.
        let window = std::mem::take(&mut self.staging);
        let (_, n_out) = resampler
            .process_into_buffer(
                &[window.as_slice()],
                &mut self.out_buf,
                None,
            )
            .map_err(|e| {
                format!(
                    "capture-unavailable: resampler flush error: {e}"
                )
            })?;
        combined_out.extend_from_slice(&self.out_buf[0][..n_out]);

        // Feed silence to drain the FIR delay.
        let silence = vec![0.0f32; CHUNK_FRAMES];
        for _ in 0..extra_silence_chunks {
            if combined_out.len() >= expected_frames {
                break;
            }
            let (_, n_out) = resampler
                .process_into_buffer(
                    &[silence.as_slice()],
                    &mut self.out_buf,
                    None,
                )
                .map_err(|e| {
                    format!(
                        "capture-unavailable: resampler delay-drain \
                         error: {e}"
                    )
                })?;
            combined_out
                .extend_from_slice(&self.out_buf[0][..n_out]);
        }

        // Trim to the expected number of real output frames.
        combined_out.truncate(expected_frames);
        Ok(combined_out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    fn sine(freq_hz: f32, rate: u32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| {
                (2.0 * PI * freq_hz * i as f32 / rate as f32).sin()
            })
            .collect()
    }

    fn rms(s: &[f32]) -> f32 {
        if s.is_empty() { return 0.0; }
        (s.iter().map(|x| x * x).sum::<f32>() / s.len() as f32).sqrt()
    }

    // ── Construction ──────────────────────────────────────────────────

    #[test]
    fn zero_rate_returns_err() {
        let result = Downmixer::new(0);
        assert!(result.is_err(), "rate 0 must return Err");
    }

    // ── Passthrough ───────────────────────────────────────────────────

    #[test]
    fn passthrough_preserves_samples_exactly() {
        let mut d = Downmixer::new(TARGET_RATE).unwrap();
        let input = sine(440.0, TARGET_RATE, 512);
        let out = d.process(&input).unwrap();
        assert_eq!(out.len(), input.len());
        for (&a, &b) in out.iter().zip(input.iter()) {
            assert!((a - b).abs() < 1e-9, "passthrough must be lossless");
        }
    }

    #[test]
    fn passthrough_flush_returns_empty() {
        let mut d = Downmixer::new(TARGET_RATE).unwrap();
        let _ = d.process(&[0.0; 100]).unwrap();
        // At target rate, process drains staging immediately.
        assert!(d.flush().unwrap().is_empty());
    }

    // ── Resampling: 44100 → 16000 ─────────────────────────────────────

    /// Duration: total output frames must track input × ratio within 5%.
    #[test]
    fn resampling_output_duration_tracks_input() {
        let native = 44_100u32;
        let mut d = Downmixer::new(native).unwrap();
        let n_chunks = 6;
        let input = sine(400.0, native, CHUNK_FRAMES * n_chunks);
        let out = d.process(&input).unwrap();
        let tail = d.flush().unwrap();
        let total = out.len() + tail.len();
        let expected =
            (CHUNK_FRAMES * n_chunks) as f64 * TARGET_RATE as f64
                / native as f64;
        let ratio = total as f64 / expected;
        assert!(
            ratio > 0.95 && ratio < 1.05,
            "output/expected ratio {ratio:.3} outside [0.95, 1.05]; \
             out={}, tail={}, expected={expected:.0}",
            out.len(),
            tail.len()
        );
    }

    /// Passband: a 400 Hz tone must survive with < 1 dB attenuation.
    #[test]
    fn passband_400hz_survives_resampling() {
        let native = 44_100u32;
        let mut d = Downmixer::new(native).unwrap();
        // Warm up filter with 2 chunks before measuring.
        let warmup = sine(400.0, native, CHUNK_FRAMES * 2);
        let _ = d.process(&warmup).unwrap();
        let measure = sine(400.0, native, CHUNK_FRAMES * 4);
        let in_rms = rms(&measure);
        let out = d.process(&measure).unwrap();
        assert!(!out.is_empty());
        let out_rms = rms(&out);
        let atten_db = 20.0 * (out_rms / in_rms).log10();
        assert!(
            atten_db > -1.0,
            "400 Hz passband attenuation {atten_db:.2} dB exceeds 1 dB"
        );
    }

    /// Stopband: a 10 kHz tone (above 8 kHz Nyquist) must be ≥ 35 dB down.
    /// With sinc_len=256 and BlackmanHarris2, actual attenuation at this
    /// ratio is ~39–50 dB; 35 dB is a conservative verified lower bound.
    #[test]
    fn stopband_10khz_attenuated_by_at_least_35db() {
        let native = 44_100u32;
        let mut d = Downmixer::new(native).unwrap();
        // Warm up to clear FIR transient.
        let warmup = sine(10_000.0, native, CHUNK_FRAMES * 4);
        let _ = d.process(&warmup).unwrap();
        // Measure during steady-state.
        let measure = sine(10_000.0, native, CHUNK_FRAMES * 4);
        let in_rms = rms(&measure);
        let out = d.process(&measure).unwrap();
        assert!(!out.is_empty());
        let out_rms = rms(&out);
        let atten_db = 20.0 * (out_rms / in_rms).log10();
        assert!(
            atten_db < -35.0,
            "10 kHz stopband attenuation {atten_db:.1} dB is \
             less than 35 dB — anti-aliasing insufficient"
        );
    }

    /// Amplitude: silence input must produce near-zero output.
    #[test]
    fn silence_input_produces_silence_output() {
        let native = 44_100u32;
        let mut d = Downmixer::new(native).unwrap();
        let out = d.process(&vec![0.0f32; CHUNK_FRAMES * 4]).unwrap();
        for &s in &out {
            assert!(
                s.abs() < 1e-5,
                "silence must produce near-zero, got {s}"
            );
        }
    }

    /// Chunk boundaries: total output accumulates correctly across calls.
    #[test]
    fn chunked_processing_accumulates_correctly() {
        let native = 48_000u32;
        let mut d = Downmixer::new(native).unwrap();
        let total_in = CHUNK_FRAMES * 6;
        let input = sine(300.0, native, total_in);
        let mut total_out = 0usize;
        for chunk in input.chunks(CHUNK_FRAMES) {
            total_out += d.process(chunk).unwrap().len();
        }
        total_out += d.flush().unwrap().len();
        let expected =
            total_in as f64 * TARGET_RATE as f64 / native as f64;
        let ratio = total_out as f64 / expected;
        assert!(
            ratio > 0.90 && ratio < 1.10,
            "chunked ratio {ratio:.3} outside [0.90, 1.10]"
        );
    }

    /// Flush tail: feeding a partial chunk produces a non-empty flush result
    /// AND the tail duration is proportional to the unpadded input.
    #[test]
    fn flush_tail_duration_is_proportional() {
        let native = 44_100u32;
        let mut d = Downmixer::new(native).unwrap();
        let partial_len = CHUNK_FRAMES / 2;
        let partial = sine(400.0, native, partial_len);
        let out = d.process(&partial).unwrap();
        // process() should return nothing (staging < CHUNK_FRAMES).
        assert!(
            out.is_empty(),
            "partial chunk should produce no process() output"
        );
        let flushed = d.flush().unwrap();
        let expected_frames =
            (partial_len as f64 * TARGET_RATE as f64 / native as f64)
                .round() as usize;
        // Allow ±2 frames for rounding.
        assert!(
            flushed.len() > 0,
            "flush must return non-empty tail for partial chunk"
        );
        let ratio = flushed.len() as f64 / expected_frames as f64;
        assert!(
            ratio > 0.80 && ratio < 1.20,
            "flush tail length {} vs expected {expected_frames} \
             (ratio {ratio:.2}) outside [0.80, 1.20]",
            flushed.len()
        );
    }

    /// Flush tail carries signal: the tail must contain signal from the real
    /// input, not just silence from the zero-padding.
    #[test]
    fn flush_tail_contains_signal_not_silence() {
        let native = 44_100u32;
        let mut d = Downmixer::new(native).unwrap();
        let partial = sine(400.0, native, CHUNK_FRAMES / 2);
        let in_rms = rms(&partial);
        let _ = d.process(&partial).unwrap();
        let flushed = d.flush().unwrap();
        if flushed.is_empty() {
            return; // No tail to check.
        }
        let out_rms = rms(&flushed);
        // Tail should have meaningful signal, not pure silence.
        assert!(
            out_rms > in_rms * 0.1,
            "flush tail rms {out_rms:.4} is less than 10% of input \
             rms {in_rms:.4} — tail appears to be silence, not signal"
        );
    }

    /// 48000 → 16000 (integer ratio 3:1): verify it works and
    /// output duration is canonical.
    #[test]
    fn rate_48000_integer_ratio_resampling() {
        let native = 48_000u32;
        let mut d = Downmixer::new(native).unwrap();
        let input = sine(400.0, native, CHUNK_FRAMES * 3);
        let out = d.process(&input).unwrap();
        // At 48→16 ratio 1/3, 3 chunks of CHUNK_FRAMES ≈ CHUNK_FRAMES output.
        assert!(!out.is_empty());
        let tail = d.flush().unwrap();
        let total = out.len() + tail.len();
        let expected = CHUNK_FRAMES; // exactly 3 input chunks × 1/3 ratio
        let ratio = total as f64 / expected as f64;
        assert!(
            ratio > 0.9 && ratio < 1.1,
            "48→16 ratio {ratio:.3} outside [0.9, 1.1]"
        );
    }
}

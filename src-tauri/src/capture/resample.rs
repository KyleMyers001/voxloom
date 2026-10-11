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
/// Output accounting removes Rubato's startup delay exactly once, then emits
/// exactly round(input_frames * 16_000 / native_rate) canonical frames.
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

use crate::capture::buffer::TARGET_RATE;

/// Input chunk size in native-rate frames fed to the resampler per call.
pub const CHUNK_FRAMES: usize = 1024;

const SINC_PARAMS: SincInterpolationParameters = SincInterpolationParameters {
    f_cutoff: 0.95,
    interpolation: SincInterpolationType::Cubic,
    oversampling_factor: 128,
    sinc_len: 256,
    window: WindowFunction::BlackmanHarris2,
};

const MAX_RATIO_RELATIVE: f64 = 1.0;

pub struct Downmixer {
    accepted_input: u64,
    delay_remaining: usize,
    emitted_output: u64,
    flushed: bool,
    #[cfg(test)]
    flush_calls: usize,
    native_rate: u32,
    resampler: Option<SincFixedIn<f32>>,
    out_buf: Vec<Vec<f32>>,
    processed_input: u64,
    staging: Vec<f32>,
}

impl Downmixer {
    /// Create a downmixer for mono samples at `native_rate` Hz.
    /// Returns `Err` for rates that produce an invalid ratio (e.g. 0).
    pub fn new(native_rate: u32) -> Result<Self, String> {
        if native_rate == 0 {
            return Err(String::from("capture-unavailable: native_rate must be > 0"));
        }
        let (delay_remaining, resampler, out_buf) = if native_rate != TARGET_RATE {
            let ratio = TARGET_RATE as f64 / native_rate as f64;
            if !ratio.is_finite() || ratio <= 0.0 {
                return Err(format!(
                    "capture-unavailable: invalid resampling ratio \
                     {ratio} for native_rate={native_rate}"
                ));
            }
            let r =
                SincFixedIn::<f32>::new(ratio, MAX_RATIO_RELATIVE, SINC_PARAMS, CHUNK_FRAMES, 1)
                    .map_err(|e| format!("capture-unavailable: resampler init failed: {e}"))?;
            let max_out = r.output_frames_max();
            (r.output_delay(), Some(r), vec![vec![0.0f32; max_out]; 1])
        } else {
            (0, None, Vec::new())
        };

        Ok(Downmixer {
            accepted_input: 0,
            delay_remaining,
            emitted_output: 0,
            flushed: false,
            #[cfg(test)]
            flush_calls: 0,
            native_rate,
            out_buf,
            processed_input: 0,
            resampler,
            staging: Vec::with_capacity(CHUNK_FRAMES * 2),
        })
    }

    /// Push mono f32 frames. Returns resampled (or passthrough) frames.
    pub fn process(&mut self, mono: &[f32]) -> Result<Vec<f32>, String> {
        if self.flushed {
            return Err(String::from(
                "capture-unavailable: resampler already flushed",
            ));
        }
        self.accepted_input = self
            .accepted_input
            .checked_add(mono.len() as u64)
            .ok_or_else(|| String::from("input-limit-exceeded"))?;
        if self.resampler.is_none() {
            self.emitted_output = self.accepted_input;
            self.processed_input = self.accepted_input;
            return Ok(mono.to_vec());
        }

        self.staging.extend_from_slice(mono);
        let mut output = Vec::new();

        while self.staging.len() >= CHUNK_FRAMES {
            let window: Vec<f32> = self.staging.drain(..CHUNK_FRAMES).collect();
            let n_out = self.process_chunk(&window)?;
            self.processed_input += CHUNK_FRAMES as u64;
            let target = self.canonical_frames(self.processed_input);
            self.collect_aligned(n_out, target, &mut output);
        }

        Ok(output)
    }

    /// Drain staged input and FIR tail to the exact canonical frame count.
    pub fn flush(&mut self) -> Result<Vec<f32>, String> {
        #[cfg(test)]
        {
            self.flush_calls += 1;
        }
        if self.flushed {
            return Ok(Vec::new());
        }
        self.flushed = true;
        if self.resampler.is_none() {
            return Ok(Vec::new());
        }

        let target = self.canonical_frames(self.accepted_input);
        let mut output = Vec::with_capacity((target.saturating_sub(self.emitted_output)) as usize);
        if !self.staging.is_empty() {
            let real_frames = self.staging.len() as u64;
            self.staging.resize(CHUNK_FRAMES, 0.0);
            let window = std::mem::take(&mut self.staging);
            let n_out = self.process_chunk(&window)?;
            self.processed_input += real_frames;
            self.collect_aligned(n_out, target, &mut output);
        }

        let raw_needed = self.delay_remaining + target.saturating_sub(self.emitted_output) as usize;
        let raw_per_chunk = self
            .resampler
            .as_ref()
            .map(Resampler::output_frames_next)
            .unwrap_or(1)
            .max(1);
        let max_chunks = raw_needed.div_ceil(raw_per_chunk) + 2;
        let silence = vec![0.0f32; CHUNK_FRAMES];
        for _ in 0..max_chunks {
            if self.emitted_output >= target {
                break;
            }
            let n_out = self.process_chunk(&silence)?;
            self.collect_aligned(n_out, target, &mut output);
        }
        if self.emitted_output != target {
            return Err(format!(
                "capture-unavailable: resampler tail ended at {} of {} frames",
                self.emitted_output, target,
            ));
        }
        Ok(output)
    }

    #[cfg(test)]
    pub fn flush_calls(&self) -> usize {
        self.flush_calls
    }

    fn canonical_frames(&self, input_frames: u64) -> u64 {
        let numerator = input_frames as u128 * TARGET_RATE as u128;
        ((numerator + self.native_rate as u128 / 2) / self.native_rate as u128) as u64
    }

    fn collect_aligned(&mut self, raw_len: usize, target: u64, output: &mut Vec<f32>) {
        let skip = self.delay_remaining.min(raw_len);
        self.delay_remaining -= skip;
        let available = raw_len - skip;
        let remaining = target.saturating_sub(self.emitted_output) as usize;
        let take = available.min(remaining);
        output.extend_from_slice(&self.out_buf[0][skip..skip + take]);
        self.emitted_output += take as u64;
    }

    fn process_chunk(&mut self, input: &[f32]) -> Result<usize, String> {
        let resampler = self
            .resampler
            .as_mut()
            .ok_or_else(|| String::from("capture-unavailable: missing resampler"))?;
        let (_, produced) = resampler
            .process_into_buffer(&[input], &mut self.out_buf, None)
            .map_err(|error| format!("capture-unavailable: resampler error: {error}"))?;
        Ok(produced)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    fn sine(freq_hz: f32, rate: u32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| (2.0 * PI * freq_hz * i as f32 / rate as f32).sin())
            .collect()
    }

    fn rms(s: &[f32]) -> f32 {
        if s.is_empty() {
            return 0.0;
        }
        (s.iter().map(|x| x * x).sum::<f32>() / s.len() as f32).sqrt()
    }

    fn canonical_frames(input_frames: usize, native_rate: u32) -> usize {
        let numerator = input_frames as u128 * TARGET_RATE as u128;
        ((numerator + native_rate as u128 / 2) / native_rate as u128) as usize
    }

    fn normalize(input: &[f32], native_rate: u32, call_sizes: &[usize]) -> Vec<f32> {
        let mut downmixer = Downmixer::new(native_rate).unwrap();
        let mut output = Vec::new();
        let mut offset = 0;
        let mut call_index = 0;
        while offset < input.len() {
            let requested = call_sizes[call_index % call_sizes.len()];
            let end = (offset + requested).min(input.len());
            output.extend(downmixer.process(&input[offset..end]).unwrap());
            offset = end;
            call_index += 1;
        }
        output.extend(downmixer.flush().unwrap());
        output
    }

    // Construction

    #[test]
    fn zero_rate_returns_err() {
        let result = Downmixer::new(0);
        assert!(result.is_err(), "rate 0 must return Err");
    }

    // Passthrough

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

    // Resampling: 44100 → 16000

    #[test]
    fn canonical_length_is_exact_for_44100_and_48000() {
        let lengths = [1, 2, 17, 1_023, 1_024, 1_025, 3_405];
        for native_rate in [44_100, 48_000] {
            for input_len in lengths {
                let input = sine(400.0, native_rate, input_len);
                let output = normalize(&input, native_rate, &[73, 1_024, 19]);
                assert_eq!(
                    output.len(),
                    canonical_frames(input_len, native_rate),
                    "wrong canonical length for {input_len} at {native_rate}",
                );
            }
        }
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
            assert!(s.abs() < 1e-5, "silence must produce near-zero, got {s}");
        }
    }

    #[test]
    fn fragmented_calls_match_single_call_sample_for_sample() {
        let native_rate = 44_100;
        let input = sine(731.0, native_rate, CHUNK_FRAMES * 4 + 317);
        let single = normalize(&input, native_rate, &[input.len()]);
        let fragmented = normalize(&input, native_rate, &[1, 37, 1_023, 5]);
        assert_eq!(fragmented.len(), single.len());
        for (index, (actual, expected)) in fragmented.iter().zip(single.iter()).enumerate() {
            assert!(
                (actual - expected).abs() < 1e-6,
                "chunking changed frame {index}: {actual} vs {expected}",
            );
        }
    }

    #[test]
    fn exact_block_flush_drains_remaining_aligned_frames() {
        let native_rate = 48_000;
        let input = sine(400.0, native_rate, CHUNK_FRAMES);
        let mut downmixer = Downmixer::new(native_rate).unwrap();
        let output = downmixer.process(&input).unwrap();
        let tail = downmixer.flush().unwrap();
        assert!(!tail.is_empty(), "exact blocks still have an FIR tail");
        assert_eq!(
            output.len() + tail.len(),
            canonical_frames(input.len(), native_rate),
        );
        assert!(downmixer.flush().unwrap().is_empty());
    }

    #[test]
    fn trailing_impulse_remains_aligned_after_flush() {
        for native_rate in [44_100, 48_000] {
            let input_len = CHUNK_FRAMES * 3 + 317;
            let impulse_index = input_len - 97;
            let mut input = vec![0.0; input_len];
            input[impulse_index] = 1.0;
            let startup_delay = Downmixer::new(native_rate).unwrap().delay_remaining;
            let output = normalize(&input, native_rate, &[211, 17, 1_024]);
            let actual_peak = output
                .iter()
                .enumerate()
                .max_by(|left, right| left.1.abs().total_cmp(&right.1.abs()))
                .map(|(index, _)| index)
                .unwrap();
            let expected_peak =
                canonical_frames(impulse_index, native_rate).saturating_sub(startup_delay);
            // Rubato's documented file-output pattern discards its leading
            // delay, so aligned source positions move left by that amount.
            assert!(
                actual_peak.abs_diff(expected_peak) <= 2,
                "trailing peak misaligned at {native_rate}: \
                 actual {actual_peak}, expected {expected_peak}",
            );
        }
    }

    #[test]
    fn passthrough_tiny_partial_exact_and_multiblock_are_exact() {
        for input_len in [1, 17, 1_024, 1_025, 4_333] {
            let input = sine(400.0, TARGET_RATE, input_len);
            let output = normalize(&input, TARGET_RATE, &[3, 1_024, 11]);
            assert_eq!(output, input);
        }
    }
}

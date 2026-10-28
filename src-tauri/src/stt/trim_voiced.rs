//! BUS-143: is there voiced speech in a stretch of the tail?
//!
//! Soft speech and a breath or a key click both move the level, so the level
//! alone cannot tell them apart (a breath was kept as speech in 19 of 20
//! base.en clips, and Whisper added "Thank you"). Voiced speech repeats at
//! its pitch period; a breath, a click or room noise does not. A 40 ms frame
//! counts as voiced when its normalized autocorrelation reaches
//! `MIN_PERIODICITY` at some lag from 60 to 400 Hz, after a 150 Hz high-pass
//! (rumble and 1/f room noise correlate at those lags, and without the
//! filter pink room noise reached 0.6, as high as speech).

/// A frame is voiced from this autocorrelation peak. Measured on the QA
/// clips (BUS-143): breath and click tails stay under 0.40, the soft words
/// kept at 0.46 or more.
const MIN_PERIODICITY: f32 = 0.42;
/// Voiced frames needed in the window. One frame is what a click's ringing
/// gives; speech keeps its pitch for a syllable.
pub(super) const MIN_VOICED_FRAMES: usize = 2;
const PITCH_HZ: (u32, u32) = (60, 400);
const HIGH_PASS_HZ: f32 = 150.0;

/// `samples` after a 2nd-order Butterworth high-pass at `HIGH_PASS_HZ`.
pub(super) fn high_pass(samples: &[f32], rate_hz: u32) -> Vec<f32> {
    let k = (std::f32::consts::PI * HIGH_PASS_HZ / rate_hz as f32).tan();
    let norm = 1.0 / (1.0 + std::f32::consts::SQRT_2 * k + k * k);
    let (b0, b1) = (norm, -2.0 * norm);
    let a1 = 2.0 * (k * k - 1.0) * norm;
    let a2 = (1.0 - std::f32::consts::SQRT_2 * k + k * k) * norm;
    let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
    samples
        .iter()
        .map(|&x| {
            let y = b0 * (x + x2) + b1 * x1 - a1 * y1 - a2 * y2;
            (x2, x1, y2, y1) = (x1, x, y1, y);
            y
        })
        .collect()
}

/// The highest normalized autocorrelation of `frame` over the pitch lags
/// (0 for a frame shorter than two periods of the lowest pitch).
pub(super) fn periodicity(frame: &[f32], rate_hz: u32) -> f32 {
    let (lo, hi) = (rate_hz / PITCH_HZ.1, rate_hz / PITCH_HZ.0);
    let (lo, hi) = (lo as usize, hi as usize);
    if frame.len() < 2 * hi {
        return 0.0;
    }
    let mean = frame.iter().sum::<f32>() / frame.len() as f32;
    let x: Vec<f32> = frame.iter().map(|s| s - mean).collect();
    (lo.max(1)..=hi)
        .map(|lag| {
            let (a, b) = (&x[..x.len() - lag], &x[lag..]);
            let dot: f32 = a.iter().zip(b).map(|(p, q)| p * q).sum();
            let energy =
                a.iter().map(|p| p * p).sum::<f32>() * b.iter().map(|q| q * q).sum::<f32>();
            dot / (energy.sqrt() + f32::MIN_POSITIVE)
        })
        .fold(0.0, f32::max)
}

/// Whether the autocorrelation peak of one frame reaches `MIN_PERIODICITY`.
pub(super) fn is_voiced(frame: &[f32], rate_hz: u32) -> bool {
    periodicity(frame, rate_hz) >= MIN_PERIODICITY
}

#[cfg(test)]
#[path = "trim_voiced_tests.rs"]
mod tests;

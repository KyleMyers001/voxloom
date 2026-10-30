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
//!
//! A thump or a low key click is a decaying 100 to 200 Hz tone: one sine is
//! as periodic as a voice (88 of 1040 QA noise clips kept a tail as speech).
//! Speech spreads its energy over many harmonics, so a frame whose energy
//! sits in one narrow peak is a tone, not a voice (`MAX_PEAK_SHARE`).

/// A frame is voiced from this autocorrelation peak. Measured on the QA
/// clips (BUS-143): breath and click tails stay under 0.40, the soft words
/// kept at 0.46 or more.
const MIN_PERIODICITY: f32 = 0.42;
/// Voiced frames needed in the window. One frame is what a click's ringing
/// gives; speech keeps its pitch for a syllable.
pub(super) const MIN_VOICED_FRAMES: usize = 2;
const PITCH_HZ: (u32, u32) = (60, 400);
const HIGH_PASS_HZ: f32 = 150.0;
/// A voiced frame has at most this share of its 70 to 1500 Hz energy within
/// `PEAK_SPAN_HZ` either side of its strongest line (100 to 500 Hz). The QA
/// thumps measured 0.5 to 1.0 and the soft words that must stay kept 0.26 or
/// less; 0.55 and under cut a real trail-off in the corpus, so 0.7 it is.
const MAX_PEAK_SHARE: f32 = 0.70;
const PEAK_SPAN_HZ: f32 = 60.0;
const BAND_HZ: (f32, f32) = (70.0, 1500.0);
const PEAK_SEARCH_HZ: (f32, f32) = (100.0, 500.0);
/// Points of the DFT grid (15.6 Hz apart at 16 kHz).
const GRID: usize = 1024;

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

/// The share of the frame's energy in `BAND_HZ` that lies within
/// `PEAK_SPAN_HZ` of its strongest line in `PEAK_SEARCH_HZ`, from a Hann
/// windowed DFT on the `GRID`. 1 for a pure tone, small for many harmonics
/// or noise.
pub(super) fn peak_share(frame: &[f32], rate_hz: u32) -> f32 {
    let n = frame.len();
    let mean = frame.iter().sum::<f32>() / n as f32;
    let x: Vec<f32> = frame
        .iter()
        .enumerate()
        .map(|(i, s)| {
            (s - mean) * (0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / (n - 1) as f32).cos())
        })
        .collect();
    let turn: Vec<(f32, f32)> = (0..GRID)
        .map(|t| (std::f32::consts::TAU * t as f32 / GRID as f32).sin_cos())
        .collect();
    let hz = |j: usize| j as f32 * rate_hz as f32 / GRID as f32;
    let power = |j: usize| {
        let (mut re, mut im) = (0.0f32, 0.0f32);
        for (i, v) in x.iter().enumerate() {
            let (s, c) = turn[(i * j) % GRID];
            (re, im) = (re + v * c, im - v * s);
        }
        re * re + im * im
    };
    let in_band: Vec<(f32, f32)> = (1..GRID / 2)
        .map(|j| (hz(j), j))
        .filter(|&(f, _)| f > BAND_HZ.0 && f < BAND_HZ.1)
        .map(|(f, j)| (f, power(j)))
        .collect();
    let line = in_band
        .iter()
        .filter(|&&(f, _)| f > PEAK_SEARCH_HZ.0 && f < PEAK_SEARCH_HZ.1)
        .fold((0.0, 0.0), |m, &(f, p)| if p > m.1 { (f, p) } else { m });
    let near: f32 = in_band
        .iter()
        .filter(|&&(f, _)| (f - line.0).abs() < PEAK_SPAN_HZ)
        .map(|&(_, p)| p)
        .sum();
    near / (in_band.iter().map(|&(_, p)| p).sum::<f32>() + f32::MIN_POSITIVE)
}

/// Whether one frame repeats at a pitch (autocorrelation peak of at least
/// `MIN_PERIODICITY`) and is not a single tone (`MAX_PEAK_SHARE`).
pub(super) fn is_voiced(frame: &[f32], rate_hz: u32) -> bool {
    periodicity(frame, rate_hz) >= MIN_PERIODICITY && peak_share(frame, rate_hz) < MAX_PEAK_SHARE
}

#[cfg(test)]
#[path = "trim_voiced_tests.rs"]
mod tests;

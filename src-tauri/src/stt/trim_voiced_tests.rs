//! BUS-143: voiced speech repeats at its pitch; noise, rumble and silence
//! do not.

use super::*;

const RATE: u32 = 16_000;
/// 40 ms, the frame `soft_speech_end` asks about.
const FRAME: usize = 640;

fn sine(hz: f32, amp: f32, n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| amp * (i as f32 * hz * std::f32::consts::TAU / RATE as f32).sin())
        .collect()
}

/// Deterministic white noise, uniform in [-amp, amp].
fn noise(amp: f32, n: usize) -> Vec<f32> {
    let mut x: u32 = 0x9e37_79b9;
    (0..n)
        .map(|_| {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            amp * ((x >> 8) as f32 / (1 << 23) as f32 - 1.0)
        })
        .collect()
}

/// A 120 Hz voice: the first ten harmonics (to 1.2 kHz), falling off.
fn voice(amp: f32, n: usize) -> Vec<f32> {
    let mut v = vec![0.0; n];
    for h in 1..=10 {
        let part = sine(120.0 * h as f32, amp / (h as f32).sqrt(), n);
        v.iter_mut().zip(part).for_each(|(a, b)| *a += b);
    }
    v
}

fn mix(a: Vec<f32>, b: Vec<f32>) -> Vec<f32> {
    a.iter().zip(&b).map(|(x, y)| x + y).collect()
}

#[test]
fn a_voice_is_voiced_even_under_noise_of_its_own_level() {
    let clean = voice(0.01, FRAME);
    assert!(periodicity(&clean, RATE) > 0.9);
    // Noise 3 dB under the voice, as for soft speech just over the floor.
    let noisy = mix(voice(0.01, FRAME), noise(0.01, FRAME));
    let filtered = high_pass(&noisy, RATE);
    assert!(
        is_voiced(&filtered, RATE),
        "{}",
        periodicity(&filtered, RATE)
    );
}

#[test]
fn white_noise_is_not_voiced() {
    // The highest of many frames, not one lucky one.
    let x = high_pass(&noise(0.01, FRAME * 50), RATE);
    let peak = x
        .chunks(FRAME)
        .map(|f| periodicity(f, RATE))
        .fold(0.0, f32::max);
    assert!(peak < MIN_PERIODICITY - 0.05, "peak {peak}");
}

#[test]
fn low_frequency_rumble_is_not_voiced_after_the_high_pass() {
    // A 50 Hz hum and its octave correlate at every lag; it is under the
    // 60 Hz pitch floor, and the filter takes most of it out.
    let hum = mix(sine(50.0, 0.01, FRAME), sine(100.0, 0.005, FRAME));
    let hum = mix(hum, noise(0.004, FRAME));
    assert!(
        periodicity(&hum, RATE) > MIN_PERIODICITY,
        "hum without filter"
    );
    let filtered = high_pass(&hum, RATE);
    assert!(
        !is_voiced(&filtered, RATE),
        "{}",
        periodicity(&filtered, RATE)
    );
}

#[test]
fn silence_and_short_frames_are_not_voiced() {
    assert!(!is_voiced(&[0.0; FRAME], RATE));
    // Two periods of the lowest pitch (60 Hz = 266 samples) are needed.
    assert!(!is_voiced(&voice(0.01, 531), RATE));
    assert!(is_voiced(&voice(0.01, 532), RATE));
}

#[test]
fn the_high_pass_keeps_speech_and_drops_rumble() {
    let rms = |x: &[f32]| (x.iter().map(|s| s * s).sum::<f32>() / x.len() as f32).sqrt();
    let n = RATE as usize;
    let passed = |hz| rms(&high_pass(&sine(hz, 0.1, n), RATE)[n / 2..]) / rms(&sine(hz, 0.1, n));
    assert!(passed(50.0) < 0.12, "50 Hz {}", passed(50.0));
    assert!(
        (passed(150.0) - 0.707).abs() < 0.05,
        "150 Hz {}",
        passed(150.0)
    );
    assert!(passed(1000.0) > 0.95, "1 kHz {}", passed(1000.0));
}

/// A thump: a 150 Hz tone dying away over `tau_ms`, in room noise.
fn thump(tau_ms: f32, n: usize) -> Vec<f32> {
    let tau = tau_ms * RATE as f32 / 1000.0;
    let ring = sine(150.0, 0.02, n)
        .iter()
        .enumerate()
        .map(|(i, s)| s * (-(i as f32) / tau).exp())
        .collect();
    mix(ring, noise(0.002, n))
}

#[test]
fn a_decaying_low_tone_repeats_at_a_pitch_but_is_not_a_voice() {
    // QA's thumps and low key clicks: periodic as a voice, one line as a
    // spectrum. The autocorrelation alone kept 88 of 1040 noise clips.
    let x = high_pass(&thump(60.0, FRAME), RATE);
    assert!(periodicity(&x, RATE) > 0.9, "{}", periodicity(&x, RATE));
    assert!(peak_share(&x, RATE) > 0.9, "{}", peak_share(&x, RATE));
    assert!(!is_voiced(&x, RATE));
}

#[test]
fn a_voice_spreads_its_energy_over_harmonics() {
    let clean = high_pass(&voice(0.01, FRAME), RATE);
    assert!(
        peak_share(&clean, RATE) < 0.4,
        "{}",
        peak_share(&clean, RATE)
    );
    let noisy = high_pass(&mix(voice(0.01, FRAME), noise(0.01, FRAME)), RATE);
    assert!(peak_share(&noisy, RATE) < MAX_PEAK_SHARE);
    // Noise alone has no line to concentrate on.
    let hiss = high_pass(&noise(0.01, FRAME), RATE);
    assert!(peak_share(&hiss, RATE) < 0.3, "{}", peak_share(&hiss, RATE));
}

#[test]
fn the_peak_share_is_the_energy_within_60_hz_of_the_strongest_line() {
    // Two equal lines 300 Hz apart: half the energy each, so half in span.
    let two = mix(sine(200.0, 0.01, FRAME), sine(500.0, 0.01, FRAME));
    let share = peak_share(&two, RATE);
    assert!((share - 0.5).abs() < 0.05, "{share}");
    // Lines 40 Hz apart fall into one span.
    let near = mix(sine(200.0, 0.01, FRAME), sine(240.0, 0.01, FRAME));
    assert!(peak_share(&near, RATE) > 0.9);
    // Only 100 to 500 Hz counts as the strongest line: a louder 800 Hz line
    // is not it.
    let high = mix(sine(300.0, 0.005, FRAME), sine(800.0, 0.02, FRAME));
    assert!(peak_share(&high, RATE) < 0.1);
}

#[test]
fn the_pitch_lags_start_at_400_hz() {
    // Smooth noise (a one-pole low-pass at about 400 Hz) correlates at lags of a few samples,
    // which is a pitch above 400 Hz and not a voice.
    let mut y = 0.0;
    let smooth: Vec<f32> = noise(0.01, FRAME)
        .iter()
        .map(|x| {
            y += 0.15 * (x - y);
            y
        })
        .collect();
    let lag1 = (smooth
        .iter()
        .zip(&smooth[1..])
        .map(|(a, b)| a * b)
        .sum::<f32>())
        / smooth.iter().map(|a| a * a).sum::<f32>();
    assert!(lag1 > 0.8, "lag 1 {lag1}");
    assert!(
        periodicity(&smooth, RATE) < MIN_PERIODICITY,
        "{}",
        periodicity(&smooth, RATE)
    );
}

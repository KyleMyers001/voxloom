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

/// A 120 Hz voice: the first four harmonics, falling off.
fn voice(amp: f32, n: usize) -> Vec<f32> {
    let mut v = vec![0.0; n];
    for h in 1..=4 {
        let part = sine(120.0 * h as f32, amp / h as f32, n);
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

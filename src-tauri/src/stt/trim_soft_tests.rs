//! BUS-143: soft speech trailing off just over the room noise is kept; flat
//! noise, a ramp or a step is not, so the "Thank you." hallucinations that
//! trim_silence_tests and the real-model corpus pin stay suppressed.

use super::*;

/// 2 s of −33 dBFS speech: where the loud speech ends.
const LOUD_END: usize = 32_000;

/// Soft syllables about −57 to −54 dBFS (120 ms) with 60 ms dips, over −60 dBFS
/// room noise, for `s` seconds.
fn soft_syllables(s: f32) -> Vec<f32> {
    let n = (s / 0.18) as usize;
    let mut speech = Vec::new();
    for i in 0..n {
        let amp = [0.0020, 0.0014, 0.0022, 0.0017][i % 4];
        speech.extend(cat(&[tone(amp, 0.12), vec![0.0; secs(0.06)]]));
    }
    mix(&speech, &noise(0.001, n as f32 * 0.18))
}

fn clip_with(tail: Vec<f32>) -> Vec<f32> {
    cat(&[tone(0.03, 2.0), tail])
}

/// Room noise whose RMS goes from `from` to `to` over `s` seconds.
fn ramp(from: f32, to: f32, s: f32) -> Vec<f32> {
    let base = noise(1.0, s);
    let n = base.len() as f32;
    (base.iter().enumerate())
        .map(|(i, x)| x * (from + (to - from) * i as f32 / n))
        .collect()
}

#[test]
fn soft_syllables_running_to_the_end_are_kept() {
    // Without BUS-143 the dips between syllables went under the 6 dB level,
    // no 80 ms run reached the end and the last 1.5 s was cut.
    let clip = clip_with(soft_syllables(1.5));
    assert_eq!(keep(&clip), clip.len());
}

#[test]
fn soft_syllables_before_a_pause_are_kept_with_the_usual_tail() {
    let speech = soft_syllables(1.5);
    let end = LOUD_END + speech.len();
    let clip = clip_with(cat(&[speech, noise(0.001, 3.0)]));
    let kept = keep(&clip);
    assert!(kept >= end, "kept {kept} of speech to {end}");
    assert!(
        kept <= end + KEPT + FRAME * 2,
        "kept {kept}, speech to {end}"
    );
}

#[test]
fn flat_noise_a_ramp_and_a_step_are_still_cut() {
    let cut = LOUD_END + KEPT;
    assert_eq!(keep(&clip_with(noise(0.002, 2.0))), cut, "flat noise");
    // AGC raising the gain after the speech, 6 dB over 2 s.
    assert_eq!(keep(&clip_with(ramp(0.001, 0.002, 2.0))), cut, "ramp");
    // A step up, as when a fan switches on.
    let step = cat(&[noise(0.001, 0.5), noise(0.002, 1.5)]);
    assert_eq!(keep(&clip_with(step)), cut, "step");
}

#[test]
fn blips_in_digital_silence_are_not_speech() {
    let blip = |n: usize| {
        let mut x = vec![0.0; n];
        x[secs(0.1)..secs(0.1) + 40]
            .iter_mut()
            .for_each(|s| *s = 0.02);
        x
    };
    let clip = clip_with(cat(&[blip(secs(0.5)), blip(secs(0.5)), blip(secs(0.5))]));
    assert_eq!(keep(&clip), LOUD_END + KEPT);
}

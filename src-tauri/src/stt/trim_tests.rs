use super::*;

const RATE: u32 = 16_000;
const KEPT: usize = 4_000; // 250 ms at 16 kHz
const FRAME: usize = 320; // 20 ms at 16 kHz

fn secs(s: f32) -> usize {
    (s * RATE as f32) as usize
}

/// A 220 Hz tone standing in for speech; RMS = `amp` / √2.
fn tone(amp: f32, s: f32) -> Vec<f32> {
    (0..secs(s))
        .map(|i| amp * (i as f32 * 220.0 * std::f32::consts::TAU / RATE as f32).sin())
        .collect()
}

/// Deterministic white noise with the given RMS.
fn noise(rms: f32, s: f32) -> Vec<f32> {
    let mut x: u32 = 0x1234_5678;
    let amp = rms * 3f32.sqrt(); // uniform in [-amp, amp] has RMS amp/√3
    (0..secs(s))
        .map(|_| {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            amp * ((x >> 8) as f32 / (1 << 23) as f32 - 1.0)
        })
        .collect()
}

fn cat(parts: &[Vec<f32>]) -> Vec<f32> {
    parts.concat()
}

fn mix(a: &[f32], b: &[f32]) -> Vec<f32> {
    a.iter().zip(b).map(|(x, y)| x + y).collect()
}

fn keep(samples: &[f32]) -> usize {
    trailing_trim(samples, RATE).keep_len
}

#[test]
fn silence_tail_is_cut_to_the_kept_tail() {
    let clip = cat(&[tone(0.3, 2.0), vec![0.0; secs(2.0)]]);
    assert_eq!(keep(&clip), secs(2.0) + KEPT);
}

#[test]
fn quiet_noise_tail_is_cut() {
    let clip = cat(&[tone(0.3, 2.0), noise(0.002, 2.0)]);
    assert_eq!(keep(&clip), secs(2.0) + KEPT);
}

#[test]
fn higher_noise_floor_still_trims_when_speech_is_much_louder() {
    // −36 dBFS floor: above the absolute floor, far below the speech.
    let floor = noise(0.015, 4.0);
    let speech = cat(&[tone(0.5, 2.0), vec![0.0; secs(2.0)]]);
    let clip = mix(&speech, &floor);
    let trim = trailing_trim(&clip, RATE);
    assert!(trim.threshold > 0.015, "threshold {}", trim.threshold);
    assert!(
        (trim.tail_rms - 0.015).abs() < 0.002,
        "tail {}",
        trim.tail_rms
    );
    assert_eq!(trim.keep_len, secs(2.0) + KEPT);
}

#[test]
fn soft_final_word_is_kept() {
    // Final word ~14 dB below the rest of the dictation.
    let clip = cat(&[tone(0.3, 2.0), tone(0.06, 0.3), vec![0.0; secs(2.0)]]);
    assert_eq!(keep(&clip), secs(2.3) + KEPT);
}

#[test]
fn all_speech_clip_is_unchanged() {
    let clip = tone(0.3, 3.0);
    assert_eq!(keep(&clip), clip.len());
}

#[test]
fn leading_silence_is_untouched() {
    let clip = cat(&[vec![0.0; secs(1.5)], tone(0.3, 2.0)]);
    assert_eq!(keep(&clip), clip.len());
    let clip = cat(&[vec![0.0; secs(1.5)], tone(0.3, 2.0), vec![0.0; secs(2.0)]]);
    assert_eq!(keep(&clip), secs(3.5) + KEPT);
}

#[test]
fn all_silent_or_all_quiet_clip_is_unchanged() {
    let silent = vec![0.0; secs(2.0)];
    assert_eq!(keep(&silent), silent.len());
    let quiet = noise(0.003, 2.0);
    assert_eq!(keep(&quiet), quiet.len());
}

#[test]
fn very_short_clips_are_unchanged() {
    assert_eq!(keep(&[0.3; 100]), 100);
    assert_eq!(keep(&[0.0; 100]), 100);
    let clip = cat(&[tone(0.3, 0.2), vec![0.0; secs(0.2)]]);
    assert_eq!(keep(&clip), clip.len());
}

#[test]
fn tail_no_longer_than_the_kept_tail_is_unchanged() {
    let clip = cat(&[tone(0.3, 2.0), vec![0.0; KEPT]]);
    assert_eq!(keep(&clip), clip.len());
    let clip = cat(&[tone(0.3, 2.0), vec![0.0; KEPT + FRAME]]);
    assert_eq!(keep(&clip), secs(2.0) + KEPT);
}

#[test]
fn never_trims_to_empty() {
    let clip = cat(&[tone(0.3, 0.02), vec![0.0; secs(5.0)]]);
    assert_eq!(keep(&clip), FRAME + KEPT);
}

#[test]
fn threshold_is_a_tenth_of_speech_level_with_an_absolute_floor() {
    let loud = cat(&[tone(0.3, 2.0), vec![0.0; secs(2.0)]]);
    let t = trailing_trim(&loud, RATE).threshold;
    assert!((t - 0.3 / 2f32.sqrt() * 0.1).abs() < 0.001, "loud {t}");
    let soft = cat(&[tone(0.04, 2.0), vec![0.0; secs(2.0)]]);
    let trim = trailing_trim(&soft, RATE);
    assert_eq!(trim.threshold, 0.006);
    assert_eq!(trim.keep_len, secs(2.0) + KEPT);
}

#[test]
fn reports_tail_rms_of_the_quiet_run() {
    let clip = cat(&[tone(0.3, 2.0), noise(0.002, 2.0)]);
    let trim = trailing_trim(&clip, RATE);
    assert!((trim.tail_rms - 0.002).abs() < 0.0003, "{}", trim.tail_rms);
    assert_eq!(trailing_trim(&tone(0.3, 1.0), RATE).tail_rms, 0.0);
}

#[test]
fn trimmed_ms_reports_the_removed_duration() {
    let clip = cat(&[tone(0.3, 2.0), vec![0.0; secs(2.0)]]);
    let trim = trailing_trim(&clip, RATE);
    assert_eq!(trim.trimmed_ms(clip.len(), RATE), 1_750);
    assert_eq!(
        trailing_trim(&clip[..secs(2.0)], RATE).trimmed_ms(secs(2.0), RATE),
        0
    );
}

#[test]
fn speech_level_follows_the_loud_part_not_the_soft_bulk() {
    // 0.5 s loud then 1.5 s soft speech, then a 0.01 RMS noise tail.
    let speech = cat(&[tone(0.3, 0.5), tone(0.05, 1.5)]);
    let clip = cat(&[speech, noise(0.01, 2.0)]);
    let trim = trailing_trim(&clip, RATE);
    assert!((trim.threshold - 0.3 / 2f32.sqrt() * 0.1).abs() < 0.001);
    assert_eq!(trim.keep_len, secs(2.0) + KEPT);
}

#[test]
fn a_single_loud_click_does_not_raise_the_threshold() {
    let clip = cat(&[
        tone(0.3, 2.0),
        tone(0.95, 0.02),
        tone(0.06, 0.3),
        vec![0.0; secs(2.0)],
    ]);
    assert_eq!(keep(&clip), secs(2.3) + FRAME + KEPT);
}

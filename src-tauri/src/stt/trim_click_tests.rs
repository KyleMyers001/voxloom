//! Clicks, thumps, run length, soft final words and exact boundaries.

use super::*;

#[test]
fn a_blip_shorter_than_80_ms_is_not_a_speech_end() {
    // With no run of four loud frames anywhere, the clip is left alone.
    let clip = cat(&[tone(0.3, 0.06), vec![0.0; secs(5.0)]]);
    assert_eq!(keep(&clip), clip.len());
}

/// 2 s of speech, then 2 s of silence with `len` samples of `amp` at `at`.
fn speech_then_tail_with(at: usize, len: usize, amp: f32) -> Vec<f32> {
    let mut tail = vec![0.0; secs(2.0)];
    tail[at..at + len].iter_mut().for_each(|s| *s = amp);
    cat(&[tone(0.3, 2.0), tail])
}

#[test]
fn a_click_in_the_tail_does_not_stop_the_trim() {
    // 100 ms before the end, on a frame boundary.
    let at = secs(1.9);
    // A 3 ms click, as from a key release.
    assert_eq!(keep(&speech_then_tail_with(at, 48, 0.9)), secs(2.0) + KEPT);
    // A 25 ms thump in two frames, and straddling three.
    assert_eq!(keep(&speech_then_tail_with(at, 400, 0.5)), secs(2.0) + KEPT);
    let straddle = speech_then_tail_with(at + 300, 400, 0.5);
    assert_eq!(keep(&straddle), secs(2.0) + KEPT);
    // A 40 ms thump touching three frames.
    let thump = speech_then_tail_with(at + 10, 640, 0.5);
    assert_eq!(keep(&thump), secs(2.0) + KEPT);
}

#[test]
fn a_sustained_sound_at_the_end_still_counts_as_speech() {
    let clip = cat(&[tone(0.3, 2.0), vec![0.0; secs(2.0)], tone(0.3, 0.08)]);
    assert_eq!(keep(&clip), clip.len());
}

#[test]
fn a_soft_final_word_below_the_floor_anchors_the_kept_tail() {
    // Word at 0.004 RMS (≈ −48 dBFS): under the 0.006 floor, over the
    // quiet level of a silent tail.
    let parts = [
        tone(0.3, 2.0),
        vec![0.0; secs(0.4)],
        tone(0.006, 0.5),
        vec![0.0; secs(2.0)],
    ];
    let clip = cat(&parts);
    let trim = trailing_trim(&clip, RATE);
    assert_eq!(trim.keep_len, secs(2.9) + KEPT);
    assert_eq!(trim.quiet_level, MIN_QUIET_RMS);
    // Under 0.001 RMS room noise the quiet level follows the noise (+6 dB).
    let noisy = mix(&clip, &noise(0.001, 4.9));
    let trim = trailing_trim(&noisy, RATE);
    assert_eq!(trim.keep_len, secs(2.9) + KEPT);
    assert!(
        (trim.quiet_level - 0.002).abs() < 0.0003,
        "{}",
        trim.quiet_level
    );
}

#[test]
fn the_quiet_level_never_exceeds_the_loud_threshold() {
    // Noise at 0.005 RMS: +6 dB would be 0.01, over the 0.006 threshold.
    let clip = mix(
        &cat(&[tone(0.2, 2.0), vec![0.0; secs(2.0)]]),
        &noise(0.005, 4.0),
    );
    let trim = trailing_trim(&clip, RATE);
    assert_eq!(trim.quiet_level, trim.threshold);
    assert_eq!(trim.keep_len, secs(2.0) + KEPT);
}

#[test]
fn leading_silence_does_not_set_the_tail_noise_floor() {
    // Digital silence before the speech, 0.003 RMS room noise after it.
    let clip = cat(&[vec![0.0; secs(2.0)], tone(0.3, 2.0), noise(0.003, 2.0)]);
    assert_eq!(keep(&clip), secs(4.0) + KEPT);
}

#[test]
fn a_clip_ending_loud_on_a_partial_frame_is_unchanged() {
    let clip = &tone(0.3, 0.08)[..4 * FRAME - 1];
    assert_eq!(keep(clip), clip.len());
}

#[test]
fn levels_exactly_at_the_floor_or_threshold_count_as_loud() {
    assert_eq!(
        speech_level(&[0.0, ABSOLUTE_FLOOR_RMS]),
        Some(ABSOLUTE_FLOOR_RMS)
    );
    assert_eq!(speech_end(&[0.5, 0.5, 0.5, 0.5, 0.0], 0.5), Some(4));
    // p90 of 6 loud frames is index round(4.5) = 5.
    assert_eq!(speech_level(&[0.1, 0.2, 0.3, 0.4, 0.5, 0.6]), Some(0.6));
    // 8 frames: index round(6.3) = 6. 21 frames: index 18, not 19 (p95).
    let ramp = |n: usize| (1..=n).map(|i| i as f32 / 100.0).collect::<Vec<_>>();
    assert_eq!(speech_level(&ramp(8)), Some(7.0 / 100.0));
    assert_eq!(speech_level(&ramp(21)), Some(19.0 / 100.0));
    // The noise floor is p20 of the tail: index round(0.8) = 1.
    assert_eq!(quiet_level(&[0.003, 0.004, 0.009, 0.009, 0.009]), 0.008);
}

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
fn a_fast_it_with_a_stop_closure_counts_as_speech() {
    // 60 ms vowel, a 20 ms closure under the quiet level, a 40 ms burst,
    // all over −60 dBFS room noise (quiet level ≈ 0.002 RMS).
    let word = [tone(0.01, 0.06), tone(0.002, 0.02), tone(0.005, 0.04)];
    let clip = cat(&[tone(0.3, 2.0), vec![0.0; secs(1.0)], word.concat()]);
    let clip = cat(&[clip, vec![0.0; secs(2.0)]]);
    let clip = mix(&clip, &noise(0.001, 5.12));
    assert_eq!(keep(&clip), secs(3.12) + KEPT);
    // Two dips in a row do end the run: the vowel alone is too short.
    let gap = [tone(0.01, 0.06), vec![0.0; secs(0.04)], tone(0.005, 0.04)];
    let clip = cat(&[tone(0.3, 2.0), vec![0.0; secs(1.0)], gap.concat()]);
    assert_eq!(keep(&cat(&[clip, vec![0.0; secs(2.0)]])), secs(2.0) + KEPT);
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
    assert_eq!(trim.quiet_level, floor::MIN_QUIET_RMS);
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
    // Two dips end a run; the next run may bridge its own dip.
    let runs = [0.5, 0.5, 0.0, 0.5, 0.5, 0.0, 0.0, 0.5, 0.5];
    assert_eq!(speech_end(&runs, 0.5), Some(5));
    // A second dip ends a run even when it isn't next to the first.
    assert_eq!(speech_end(&[0.5, 0.5, 0.0, 0.5, 0.0, 0.5, 0.5], 0.5), None);
    assert_eq!(speech_end(&[0.5, 0.5, 0.0, 0.5, 0.5], 0.5), Some(5));
    // p90 of 6 loud frames is index round(4.5) = 5.
    assert_eq!(speech_level(&[0.1, 0.2, 0.3, 0.4, 0.5, 0.6]), Some(0.6));
    // 8 frames: index round(6.3) = 6. 21 frames: index 18, not 19 (p95).
    let ramp = |n: usize| (1..=n).map(|i| i as f32 / 100.0).collect::<Vec<_>>();
    assert_eq!(speech_level(&ramp(8)), Some(7.0 / 100.0));
    assert_eq!(speech_level(&ramp(21)), Some(19.0 / 100.0));
    // The noise floor is p20 of a 200 ms window: of 10 frames, index
    // round(1.8) = 2, not 1 (p10) or 3 (p30).
    let mut tail = vec![0.003, 0.004, 0.005];
    tail.extend([0.009; 7]);
    assert!((quiet_level(&tail, 1.0) - 0.01).abs() < 1e-6);
    // The lowest window sets it: an 11th frame moves the second window up.
    tail.push(0.009);
    assert!((quiet_level(&tail, 1.0) - 0.01).abs() < 1e-6);
    // Whole-tail p20 of these 21 frames would be 0.009.
    let tail = [vec![0.009; 10], tail].concat();
    assert!((quiet_level(&tail, 1.0) - 0.01).abs() < 1e-6);
}

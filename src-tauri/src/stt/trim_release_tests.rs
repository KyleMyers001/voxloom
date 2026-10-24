//! Releasing the shortcut while still trailing off: the clip ends in soft
//! speech, with no pause before the end.

use super::*;

/// 2 s of −33 dBFS speech, then `tail`, with nothing after it.
fn released_during(tail: Vec<f32>) -> Vec<f32> {
    cat(&[tone(0.03, 2.0), tail])
}

#[test]
fn a_soft_trail_off_running_to_the_end_is_kept() {
    // −49 dBFS after −33 dBFS speech: under the loud threshold and under
    // the quiet level the tail sets for itself, but nothing may be lost.
    let clip = released_during(tone(0.005, 2.0));
    let trim = trailing_trim(&clip, RATE);
    assert_eq!(trim.threshold, 0.006);
    assert_eq!(trim.keep_len, clip.len());
}

#[test]
fn the_trail_off_counts_down_to_6_db_under_the_loud_threshold() {
    // −5.3 dB under the 0.006 threshold is kept; −6.8 dB is room noise.
    let kept = released_during(tone(0.0046, 2.0));
    assert_eq!(keep(&kept), kept.len());
    assert_eq!(keep(&released_during(tone(0.0039, 2.0))), secs(2.0) + KEPT);
}

#[test]
fn the_margin_follows_a_relative_loud_threshold() {
    // Loud speech: the threshold is 0.019, and so is the edge.
    let clip = |tail: f32| cat(&[tone(0.9, 2.0), tone(tail, 2.0)]);
    let near = clip(0.017);
    assert_eq!(keep(&near), near.len());
    assert_eq!(keep(&clip(0.012)), secs(2.0) + KEPT);
}

#[test]
fn a_trail_off_that_stops_before_the_end_is_still_trimmed() {
    // The same soft speech, then a pause before the release.
    let clip = released_during(cat(&[tone(0.005, 1.0), vec![0.0; secs(2.0)]]));
    assert_eq!(keep(&clip), secs(3.0) + KEPT);
}

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

#[test]
fn a_breath_or_click_at_release_still_ends_in_speech() {
    let soft = || released_during(tone(0.005, 2.0));
    // 250 ms breaths at −45 and −50 dBFS.
    for rms in [0.0056, 0.0032] {
        let clip = cat(&[soft(), noise(rms, 0.25)]);
        assert_eq!(keep(&clip), clip.len(), "breath {rms}");
    }
    // A 5 ms click 20 or 100 ms before the end.
    for before in [secs(0.02), secs(0.1)] {
        let mut clip = soft();
        let at = clip.len() - before;
        clip[at..at + 80].iter_mut().for_each(|x| *x += 0.5);
        assert_eq!(keep(&clip), clip.len(), "click {before}");
    }
}

#[test]
fn room_noise_after_the_trail_off_keeps_it_however_short() {
    // −60 dBFS room noise for 20–800 ms before the release: up to 100 ms
    // the clip still ends in speech; from 60 ms the noise sets the floor.
    for ms in [20, 60, 100, 120, 200, 300, 500, 800] {
        let clip = released_during(cat(&[tone(0.005, 2.0), noise(0.001, ms as f32 / 1e3)]));
        let kept = (secs(4.0) + KEPT).min(clip.len());
        assert_eq!(keep(&clip), kept, "{ms} ms of room noise");
    }
}

#[test]
fn steady_room_noise_more_than_6_db_under_the_threshold_still_trims() {
    // −74 to −51 dBFS, to the end of the clip, with no speech in it.
    for rms in [0.0002, 0.0005, 0.001, 0.002, 0.0028] {
        let clip = released_during(noise(rms, 2.0));
        assert_eq!(keep(&clip), secs(2.0) + KEPT, "noise {rms}");
    }
}

#[test]
fn a_short_or_empty_tail_is_unchanged() {
    let short = released_during(tone(0.005, 0.1));
    assert_eq!(keep(&short), short.len());
    let none = released_during(vec![]);
    assert_eq!(keep(&none), none.len());
}

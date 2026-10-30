//! Releasing the shortcut while still trailing off: the clip ends in soft
//! speech, with no pause before the end. Soft speech with syllables is kept
//! (trim_soft_tests, BUS-143). A flat soft tone, which moves no more than
//! room noise, is still cut as noise here, like room noise that loud: keeping
//! it brought back "you" on 61 of 209 changed main QA clips, and a floor from
//! the tail's quietest 200 ms, which kept soft speech before short room
//! noise, brought it back on 49–77 of 162 focus clips.

use super::*;

/// 2 s of −33 dBFS speech, then `tail`, with nothing after it.
fn released_during(tail: Vec<f32>) -> Vec<f32> {
    cat(&[tone(0.03, 2.0), tail])
}

/// Where the loud speech ends and the kept tail begins.
const LOUD_END: usize = 32_000;

#[test]
fn a_flat_soft_trail_off_running_to_the_end_is_cut() {
    // A flat −49 dBFS tone after −33 dBFS speech, to the end: 1.25 s of it is lost.
    let clip = released_during(tone(0.005, 2.0));
    let trim = trailing_trim(&clip, RATE);
    assert_eq!(trim.threshold, 0.006);
    assert_eq!(trim.keep_len, LOUD_END + KEPT);
    // Just under the 0.006 threshold is cut the same way.
    assert_eq!(keep(&released_during(tone(0.008, 2.0))), LOUD_END + KEPT);
}

#[test]
fn the_cut_follows_a_relative_loud_threshold() {
    // Loud speech: the threshold is 0.019; a 0.017 tail is under it.
    let clip = |tail: f32| cat(&[tone(0.9, 2.0), tone(tail, 2.0)]);
    assert_eq!(keep(&clip(0.017)), LOUD_END + KEPT);
    let over = clip(0.03);
    assert_eq!(keep(&over), over.len());
}

#[test]
fn a_trail_off_that_stops_before_the_end_is_kept() {
    // The same soft speech, then a pause before the release.
    let clip = released_during(cat(&[tone(0.005, 1.0), vec![0.0; secs(2.0)]]));
    assert_eq!(keep(&clip), secs(3.0) + KEPT);
}

#[test]
fn a_breath_or_click_at_release_is_cut_with_the_trail_off() {
    let soft = || released_during(tone(0.005, 2.0));
    // 250 ms breaths at −45 and −50 dBFS.
    for rms in [0.0056, 0.0032] {
        assert_eq!(keep(&cat(&[soft(), noise(rms, 0.25)])), LOUD_END + KEPT);
    }
    // A 5 ms click 20 or 100 ms before the end.
    for before in [secs(0.02), secs(0.1)] {
        let mut clip = soft();
        let at = clip.len() - before;
        clip[at..at + 80].iter_mut().for_each(|x| *x += 0.5);
        assert_eq!(keep(&clip), LOUD_END + KEPT, "click {before}");
    }
}

#[test]
fn room_noise_after_the_trail_off_keeps_it_only_when_long() {
    // −60 dBFS room noise before the release sets the floor only once it
    // is over a fifth of the tail: up to 500 ms of it, the 2 s of soft
    // speech is cut too (a flat tone: known loss).
    let clip = |ms: u32| released_during(cat(&[tone(0.005, 2.0), noise(0.001, ms as f32 / 1e3)]));
    for ms in [20, 60, 100, 200, 300, 500] {
        assert_eq!(keep(&clip(ms)), LOUD_END + KEPT, "{ms} ms of room noise");
    }
    assert_eq!(keep(&clip(800)), secs(4.0) + KEPT);
}

#[test]
fn steady_room_noise_to_the_end_trims() {
    // −74 to −45 dBFS, to the end of the clip, with no speech in it.
    for rms in [0.0002, 0.0005, 0.001, 0.002, 0.0028, 0.004, 0.0056] {
        let clip = released_during(noise(rms, 2.0));
        assert_eq!(keep(&clip), LOUD_END + KEPT, "noise {rms}");
    }
}

#[test]
fn a_short_or_empty_tail_is_unchanged() {
    let short = released_during(tone(0.005, 0.1));
    assert_eq!(keep(&short), short.len());
    let none = released_during(vec![]);
    assert_eq!(keep(&none), none.len());
}

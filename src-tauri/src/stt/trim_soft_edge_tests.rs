//! BUS-143: the limits of `soft_speech_end`, one at a time. The tails are
//! built frame by frame (20 ms, an exact RMS each) over a 0.001 RMS floor,
//! so a level 1.9× the floor is above the +3 dB soft level (1.41×) and under
//! the +6 dB quiet level (2×), where only trim_soft can keep it.

use super::*;

const FLOOR: f32 = 0.001;
/// Frames of the 2 s of loud speech before the tail.
const LOUD_FRAMES: usize = 100;
/// Soft speech: strong (1.9×, 1.6×) and weak (1.3×, under the soft level)
/// frames, moving like syllables.
const HI: f32 = 0.0019;
const MID: f32 = 0.0016;
const LO: f32 = 0.0013;

/// One 20 ms frame per level: a 200 Hz tone (4 whole cycles per frame, so
/// the frame RMS is exact, and voiced).
fn frames(levels: &[f32]) -> Vec<f32> {
    let per = FRAME;
    (0..levels.len() * per)
        .map(|i| {
            let phase = (i % 80) as f32 * std::f32::consts::TAU / 80.0;
            levels[i / per] * std::f32::consts::SQRT_2 * phase.sin()
        })
        .collect()
}

/// The frame the kept speech ends at: `keep` less the kept tail, over 20 ms.
fn kept_frame(tail: &[f32]) -> usize {
    let clip = cat(&[tone(0.03, 2.0), frames(tail)]);
    (keep(&clip) - KEPT) / FRAME
}

fn tail(parts: &[&[f32]]) -> Vec<f32> {
    parts.concat()
}

/// Ten frames of soft syllables ending on a strong one.
const SYLLABLES: [f32; 10] = [HI, LO, MID, LO, HI, LO, MID, LO, HI, MID];

#[test]
fn an_extension_needs_500_ms_and_ends_at_the_last_frame() {
    let floor = |n| vec![FLOOR; n];
    // 15 floor frames, then syllables to frame 124: 24 frames, not enough.
    let short = tail(&[&floor(15), &SYLLABLES, &floor(40)]);
    assert_eq!(kept_frame(&short), LOUD_FRAMES);
    // One frame more: 25 frames, kept to the end of the last syllable.
    let long = tail(&[&floor(16), &SYLLABLES, &floor(40)]);
    assert_eq!(kept_frame(&long), LOUD_FRAMES + 16 + 10 - 1);
}

#[test]
fn four_strong_frames_in_the_window_are_not_speech() {
    let floor = vec![FLOOR; 40];
    let four = [HI, FLOOR, MID, FLOOR, FLOOR, HI, FLOOR, FLOOR, FLOOR, MID];
    assert_eq!(
        kept_frame(&tail(&[&floor, &four, &[FLOOR; 10]])),
        LOUD_FRAMES
    );
    let five = [HI, FLOOR, MID, FLOOR, HI, FLOOR, FLOOR, FLOOR, MID, HI];
    let kept = kept_frame(&tail(&[&floor, &five, &[FLOOR; 40]]));
    assert_eq!(kept, LOUD_FRAMES + 40 + 10);
}

#[test]
fn weak_frames_under_the_soft_level_do_not_count() {
    let weak = [HI, LO, FLOOR, LO, MID, LO, FLOOR, LO, HI, MID];
    let clip = tail(&[&[FLOOR; 40], &weak, &[FLOOR; 10]]);
    assert_eq!(kept_frame(&clip), LOUD_FRAMES);
}

#[test]
fn a_step_up_is_not_speech() {
    // The window moves at the step, but the frames over the soft level are
    // flat.
    let clip = tail(&[&[FLOOR; 40], &[MID; 30]]);
    assert_eq!(kept_frame(&clip), LOUD_FRAMES);
}

#[test]
fn levels_that_move_less_than_1_5_db_are_not_speech() {
    // Alternating 1.43× and 1.99× the floor: 2.9 dB apart, std 1.44 dB.
    let alternating: Vec<f32> = (0..30).map(|i| [0.00143, 0.00199][i % 2]).collect();
    let clip = tail(&[&alternating, &[FLOOR; 15]]);
    assert_eq!(kept_frame(&clip), LOUD_FRAMES);
}

#[test]
fn blips_over_a_digitally_silent_floor_are_not_speech() {
    // 0.0001 RMS (−80 dBFS) floor with frames 1.9× over it, which a −74 dBFS
    // floor would take for soft speech.
    let low = 0.1;
    let blips: Vec<f32> = SYLLABLES.iter().map(|x| x * low).collect();
    let clip = tail(&[&[FLOOR * low; 30], &blips]);
    assert_eq!(kept_frame(&clip), LOUD_FRAMES);
}

#[test]
fn a_tail_that_ends_in_a_gate_is_not_scanned_for_soft_speech() {
    let clip = tail(&[&[FLOOR; 60], &SYLLABLES, &[0.0; 10]]);
    assert_eq!(kept_frame(&clip), LOUD_FRAMES);
}

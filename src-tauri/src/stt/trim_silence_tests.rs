//! Digital silence in the tail, as left by a device or OS noise gate.

use super::*;

/// 2 s of speech, `room` RMS noise for `room_s`, then 2 s of `after`.
fn speech_room_then(room: f32, room_s: f32, after: Vec<f32>) -> Vec<f32> {
    cat(&[tone(0.3, 2.0), noise(room, room_s), after])
}

#[test]
fn room_noise_cut_to_digital_silence_is_not_speech() {
    // 200 ms of −68 dBFS room noise, then exact zeros: the floor comes from
    // the room noise, so the noise is trimmed like the zeros.
    let clip = speech_room_then(0.0004, 0.2, vec![0.0; secs(2.0)]);
    let trim = trailing_trim(&clip, RATE);
    assert_eq!(trim.keep_len, secs(2.0) + KEPT);
    assert!(
        (trim.quiet_level - 0.0008).abs() < 0.0002,
        "{}",
        trim.quiet_level
    );
    // The same after ±1 LSB dither instead of exact zeros.
    let dither = noise(0.00003, 2.0);
    assert_eq!(
        keep(&speech_room_then(0.0004, 0.2, dither)),
        secs(2.0) + KEPT
    );
}

#[test]
fn a_short_decay_before_digital_silence_does_not_set_the_floor() {
    // 100 ms of decay is too short to measure: a soft word (−66 dBFS)
    // after the silence still counts.
    let parts = [
        tone(0.3, 2.0),
        noise(0.003, 0.1),
        vec![0.0; secs(0.4)],
        noise(0.0005, 0.3),
        vec![0.0; secs(2.0)],
    ];
    assert_eq!(keep(&cat(&parts)), secs(2.8) + KEPT);
}

#[test]
fn the_quiet_floor_over_digital_silence_is_minus_74_dbfs() {
    let with = |rms: f32| {
        let after = [vec![0.0; secs(1.0)], noise(rms, 0.3), vec![0.0; secs(1.0)]];
        keep(&cat(&[tone(0.3, 2.0), after.concat()]))
    };
    // −77 dBFS is under the floor; −70.5 dBFS is over it.
    assert_eq!(with(0.00014), secs(2.0) + KEPT);
    assert_eq!(with(0.0003), secs(3.3) + KEPT);
}

#[test]
fn only_the_noise_just_before_digital_silence_sets_the_floor() {
    // A soft phrase (−54 dBFS) and then 200 ms of room noise before the
    // gate closes: the phrase is speech, not part of the floor.
    let soft_then_room = cat(&[noise(0.002, 1.0), noise(0.0004, 0.2)]);
    let clip = cat(&[tone(0.3, 2.0), soft_then_room, vec![0.0; secs(2.0)]]);
    assert_eq!(keep(&clip), secs(3.0) + KEPT);
}

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

#[test]
fn soft_speech_running_into_digital_silence_is_kept() {
    // Soft speech (0.006 peak, under the loud threshold) straight after the
    // loud part and into the gate: none of it sets the floor.
    for soft_s in [1.0, 1.3, 2.0] {
        let clip = speech_room_then(
            0.0,
            0.0,
            [tone(0.006, soft_s), vec![0.0; secs(2.0)]].concat(),
        );
        assert_eq!(keep(&clip), secs(2.0 + soft_s) + KEPT, "{soft_s} s");
    }
}

#[test]
fn a_faint_word_just_before_the_gate_is_kept() {
    // −60 dBFS, 180 ms, 600 ms after the speech in −70 dBFS room noise; the
    // gate closes 20 ms after the word.
    let after = [
        noise(0.000316, 0.6),
        noise(0.001, 0.18),
        noise(0.000316, 0.02),
        vec![0.0; secs(2.0)],
    ];
    assert_eq!(
        keep(&cat(&[tone(0.3, 2.0), after.concat()])),
        secs(2.78) + KEPT
    );
}

#[test]
fn dither_over_2_lsb_after_room_noise_is_still_a_gate() {
    // ±3 and ±4 LSB dither (6.1e-5 and 7.9e-5 RMS) in place of zeros.
    for dither in [0.000061, 0.000079] {
        let clip = speech_room_then(0.0004, 0.2, noise(dither, 2.0));
        assert_eq!(keep(&clip), secs(2.0) + KEPT, "{dither}");
    }
}

#[test]
fn a_gate_that_lowers_room_noise_by_20_db_is_a_gate() {
    let clip = speech_room_then(0.0006, 0.3, noise(0.00006, 2.0));
    assert_eq!(keep(&clip), secs(2.0) + KEPT);
}

#[test]
fn room_noise_over_minus_74_dbfs_is_not_a_gate() {
    // A soft final word straight after the speech, then plain room noise: the
    // noise sets the floor, so the word counts.
    let clip = speech_room_then(0.0, 0.0, [tone(0.003, 0.5), noise(0.0003, 2.0)].concat());
    assert_eq!(keep(&clip), secs(2.5) + KEPT);
}

#[test]
fn room_noise_needs_200_ms_before_the_gate_to_set_the_floor() {
    // 180 ms (9 frames) is too short to measure, so the noise counts and the
    // trim keeps it (as on main); 200 ms is trimmed.
    let with = |room_s: f32| keep(&speech_room_then(0.0004, room_s, vec![0.0; secs(2.0)]));
    assert_eq!(with(0.18), secs(2.18) + KEPT);
    assert_eq!(with(0.2), secs(2.0) + KEPT);
}

#[test]
fn a_noise_swell_just_before_the_gate_is_not_speech() {
    // Room noise rising 6.5 dB for 120 ms (a breath) as the gate closes.
    let after = [
        noise(0.0004, 0.3),
        noise(0.00085, 0.12),
        vec![0.0; secs(2.0)],
    ];
    assert_eq!(
        keep(&cat(&[tone(0.3, 2.0), after.concat()])),
        secs(2.0) + KEPT
    );
}

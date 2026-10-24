//! A noise gate after room noise, with a click, blip, dither or fade in it.

use super::*;

/// 2 s of speech, 400 ms of −60 dBFS room noise, then `gate`.
fn room_then_gate(gate: Vec<f32>) -> Vec<f32> {
    cat(&[tone(0.3, 2.0), noise(0.001, 0.4), gate])
}

const TRIMMED: usize = 32_000 + KEPT; // speech end + kept tail

#[test]
fn a_click_in_the_gate_does_not_hide_it() {
    // A 5 ms click 0.1, 0.3 or 1.0 s before the end of 1.6 s of zeros.
    for before in [0.1, 0.3, 1.0] {
        let mut clip = room_then_gate(vec![0.0; secs(1.6)]);
        let at = clip.len() - secs(before);
        clip[at..at + 80].iter_mut().for_each(|x| *x = 0.3);
        assert_eq!(keep(&clip), TRIMMED, "click {before} s before the end");
    }
}

#[test]
fn a_blip_at_the_gate_floor_does_not_end_it() {
    // 200 ms at −74 dBFS, 0.3 or 1.0 s before the end.
    for before in [0.3, 1.0] {
        let blip = tone(0.0002 * 2f32.sqrt(), 0.2);
        let gate = [vec![0.0; secs(1.4 - before)], blip, vec![0.0; secs(before)]];
        assert_eq!(keep(&room_then_gate(gate.concat())), TRIMMED, "{before}");
    }
}

#[test]
fn a_gate_fading_through_dither_is_still_a_gate() {
    // 1 s of ±2 to ±4 LSB dither, then zeros.
    for lsb in [2.0, 3.0, 4.0] {
        let fade = noise(lsb / 32_768.0, 1.0);
        let clip = room_then_gate(cat(&[fade, vec![0.0; secs(1.0)]]));
        assert_eq!(keep(&clip), TRIMMED, "{lsb} LSB");
    }
}

#[test]
fn room_noise_fading_into_the_gate_is_not_speech() {
    // The noise fades out over 50–200 ms, linearly or by 40 dB.
    for s in [0.05, 0.1, 0.2] {
        let n = noise(0.001, s);
        let k = n.len() as f32;
        let fades = [
            n.iter()
                .enumerate()
                .map(|(i, v)| v * (1.0 - i as f32 / k))
                .collect(),
            n.iter()
                .enumerate()
                .map(|(i, v)| v * 0.01f32.powf(i as f32 / k))
                .collect(),
        ];
        for fade in fades {
            let clip = room_then_gate(cat(&[fade, vec![0.0; secs(1.5)]]));
            assert_eq!(keep(&clip), TRIMMED, "{s} s fade");
        }
    }
}

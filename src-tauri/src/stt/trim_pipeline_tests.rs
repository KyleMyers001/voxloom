//! BUS-139 soft final words through the shipped path: `transcribe_filtered`
//! with an engine that records what it was given. The dictation is a train
//! of syllables (220 ms vowels with 40 ms ramps, 60 ms gaps, varying pitch
//! and level); the final word is three of the same syllables, after a
//! 400 ms pause, attenuated by the given dB against the dictation.

use super::super::{
    engine::TranscriptDto, filter_config::SpeechFilterConfig, gate::NoVad,
    pipeline::transcribe_filtered,
};

const RATE: usize = 16_000;
const KEPT: usize = RATE * 3 / 4; // 750 ms

fn ms(n: usize) -> usize {
    RATE * n / 1000
}

fn syllable(amp: f32, hz: f32) -> Vec<f32> {
    let (len, ramp) = (ms(220), ms(40));
    (0..len)
        .map(|i| {
            let edge = i.min(len - 1 - i) as f32 / ramp as f32;
            let env = 0.5 - 0.5 * (edge.min(1.0) * std::f32::consts::PI).cos();
            amp * env * (i as f32 * hz * std::f32::consts::TAU / RATE as f32).sin()
        })
        .chain(std::iter::repeat_n(0.0, ms(60)))
        .collect()
}

fn syllables(count: usize, gain: f32) -> Vec<f32> {
    const LEVELS: [f32; 5] = [1.0, 0.8, 0.9, 0.7, 0.85];
    const PITCH: [f32; 5] = [180.0, 220.0, 260.0, 200.0, 240.0];
    (0..count)
        .flat_map(|i| syllable(0.5 * LEVELS[i % 5] * gain, PITCH[i % 5]))
        .collect()
}

/// Dictation, pause, final word at `-db` dB, then 2 s of silence. Returns
/// the clip and the sample index just past the final word's last vowel.
fn dictation_with_final_word(db: f32) -> (Vec<f32>, usize) {
    let mut clip = syllables(10, 1.0);
    clip.extend(std::iter::repeat_n(0.0, ms(400)));
    clip.extend(syllables(3, 10f32.powf(-db / 20.0)));
    let word_end = clip.len() - ms(60);
    clip.extend(std::iter::repeat_n(0.0, 2 * RATE));
    (clip, word_end)
}

/// Samples the engine was handed for `clip`.
fn engine_sees(clip: &[f32]) -> usize {
    let mut seen = 0;
    transcribe_filtered(
        clip,
        RATE as u32,
        &SpeechFilterConfig::default(),
        &NoVad,
        |pcm| {
            seen = pcm.len();
            Ok(TranscriptDto::raw("x".into(), None))
        },
    )
    .unwrap();
    seen
}

fn assert_final_word_kept(db: f32) {
    let (clip, word_end) = dictation_with_final_word(db);
    let seen = engine_sees(&clip);
    assert!(
        seen >= word_end,
        "-{db} dB: engine saw {seen} of {word_end}"
    );
    assert_tail_trimmed_to_kept(seen, word_end);
}

/// The silent tail was cut to about 750 ms after the last vowel (its fade
/// can fall below the threshold a few frames early).
fn assert_tail_trimmed_to_kept(seen: usize, vowel_end: usize) {
    let tail = seen as isize - vowel_end as isize;
    let range = (KEPT - ms(80)) as isize..=KEPT as isize;
    assert!(
        range.contains(&tail),
        "kept {} ms after the vowel",
        tail * 1000 / RATE as isize
    );
}

#[test]
fn final_word_20_db_down_is_kept() {
    assert_final_word_kept(20.0);
}

#[test]
fn final_word_26_db_down_is_kept() {
    assert_final_word_kept(26.0);
}

#[test]
fn final_word_30_db_down_is_kept() {
    assert_final_word_kept(30.0);
}

#[test]
fn silent_tail_after_the_dictation_is_trimmed() {
    let mut clip = syllables(10, 1.0);
    let speech_end = clip.len() - ms(60);
    clip.extend(std::iter::repeat_n(0.0, 2 * RATE));
    let seen = engine_sees(&clip);
    assert!(seen < clip.len() - RATE, "tail not trimmed: {seen}");
    assert_tail_trimmed_to_kept(seen, speech_end);
}

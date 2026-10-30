//! BUS-143: keep soft speech that trails off just above the room noise.
//!
//! `trim_floor`'s quiet level sits 6 dB over the tail's noise floor. Speech
//! 3–10 dB over the floor (a quiet speaker trailing off, −50 to −56 dBFS in
//! −60 dBFS room noise) dips under that level between syllables, so no run of
//! `MIN_SPEECH_FRAMES` reaches the end of the speech and the last words were
//! cut with the "silence" (5 of 96 base.en trail-off clips, BUS-143).
//!
//! This looks for speech the 6 dB level misses: a 200 ms window where half
//! the frames are 3 dB over the floor and the level moves, as speech does:
//! the window's levels vary (std ≥ 1.5 dB) and so do the frames over the
//! soft level (std ≥ 0.5 dB, which a single step down from a tone or a
//! breath to quiet doesn't give). Room noise, a step or a ramp (AGC raising
//! the gain after speech) is nearly flat and is still cut, which keeps the
//! "Thank you." hallucinations suppressed.
//!
//! Breaths, key clicks and wandering room noise move the level too, and a
//! breath kept as speech brought "Thank you" back (BUS-143, QA of e2e7565:
//! 19 of 20 base.en breath tails). So the window must also hold voiced
//! speech (`trim_voiced`): a pitch-period repeat that noise does not have.

use super::voiced::{high_pass, is_voiced, MIN_VOICED_FRAMES};
use super::{percentile, MIN_SPEECH_FRAMES};

/// Floor of the tail: the same low percentile `trim_floor` uses.
const NOISE_PERCENTILE: f32 = 0.2;
/// Soft speech level: the floor times this (+3 dB).
const SOFT_MARGIN: f32 = 1.41;
/// Window (200 ms) and the frames in it that must reach the soft level.
const WINDOW_FRAMES: usize = 10;
const MIN_ABOVE: usize = MIN_SPEECH_FRAMES + 1;
/// Least movement (population std, dB) of the window's levels, and of those
/// that reach the soft level.
const MIN_MOVEMENT_DB: f32 = 1.5;
const MIN_ABOVE_MOVEMENT_DB: f32 = 0.5;
/// Least extension (500 ms) worth making. The kept tail already covers a
/// short syllable, and moving the end by a few frames only shifts where
/// Whisper's "Thank you" tipping point falls (±30 ms flipped it on real
/// clips). The words BUS-143 lost were cut 0.8–1.5 s early.
const MIN_EXTENSION_FRAMES: usize = 25;
/// The digital-silence level `trim_floor` uses (≈ −74 dBFS).
const MIN_FLOOR_RMS: f32 = super::floor::MIN_QUIET_RMS;

/// The end frame of speech in `levels[from..]`, at or after `end_frame`.
/// `levels` holds the RMS of each `frame` samples of `samples`. Only used
/// when the tail does not end in a noise gate (a gate keeps its own, exact
/// floor).
pub(super) fn soft_speech_end(
    (samples, rate_hz, frame): (&[f32], u32, usize),
    levels: &[f32],
    from: usize,
    end_frame: usize,
) -> usize {
    let Some(tail_floor) = percentile(levels[from..].to_vec(), NOISE_PERCENTILE) else {
        return end_frame;
    };
    // Under this the tail is (near) digital silence: the quiet level is its
    // fixed minimum, which any sound over −74 dBFS reaches, so no soft speech
    // hides under it and two blips aren't speech.
    if tail_floor < MIN_FLOOR_RMS {
        return end_frame;
    }
    let floor = tail_floor;
    let soft = floor * SOFT_MARGIN;
    // Levels in dB, frames under the floor counted as the floor, so a quiet
    // frame can't make a flat window look like it moves.
    let db: Vec<f32> = levels
        .iter()
        .map(|&r| 20.0 * r.max(floor).log10())
        .collect();
    // The tail after the loud anchor, high-passed once; `voiced[k]` caches
    // whether the 40 ms from frame k is voiced.
    let tail = high_pass(&samples[(from * frame).min(samples.len())..], rate_hz);
    let mut voiced: Vec<Option<bool>> = vec![None; levels.len()];
    let mut is_voiced_at = |k: usize| {
        *voiced[k].get_or_insert_with(|| {
            let (a, b) = ((k - from) * frame, (k + 2 - from) * frame);
            tail.get(a..b).is_some_and(|f| is_voiced(f, rate_hz))
        })
    };
    for i in (end_frame..levels.len()).rev() {
        if levels[i] < soft {
            continue;
        }
        let start = from.max((i + 1).saturating_sub(WINDOW_FRAMES));
        let above: Vec<f32> = (start..=i)
            .filter(|&j| levels[j] >= soft)
            .map(|j| db[j])
            .collect();
        if above.len() >= MIN_ABOVE
            && std_dev(&db[start..=i]) >= MIN_MOVEMENT_DB
            && std_dev(&above) >= MIN_ABOVE_MOVEMENT_DB
            && (start..i).filter(|&k| is_voiced_at(k)).count() >= MIN_VOICED_FRAMES
        {
            return if i + 1 >= end_frame + MIN_EXTENSION_FRAMES {
                i + 1
            } else {
                end_frame
            };
        }
    }
    end_frame
}

fn std_dev(values: &[f32]) -> f32 {
    let mean = values.iter().sum::<f32>() / values.len() as f32;
    let var = values.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / values.len() as f32;
    var.sqrt()
}

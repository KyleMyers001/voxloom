//! BUS-139: the quiet level that ends speech in the tail: the tail's noise
//! floor plus a margin, measured before a noise gate when there is one.
//! Also whether the clip still ends in soft speech, so there is no tail.

use super::{percentile, MIN_SPEECH_FRAMES};

/// Noise floor: the lowest of this percentile over each 200 ms window.
/// Low, so a soft final word longer than the noise doesn't set it.
const NOISE_PERCENTILE: f32 = 0.2;
/// Window for the noise floor (200 ms). 60 ms of room noise after a soft
/// final word is enough to set it, so the word still counts.
const NOISE_FRAMES: usize = 10;
/// Quiet level: the floor times this (+6 dB).
const NOISE_MARGIN: f32 = 2.0;
/// Lowest quiet level (≈ −74 dBFS), for a digitally silent tail. A final
/// word 32 dB under −30 dBFS speech sits near −62 dBFS.
pub(super) const MIN_QUIET_RMS: f32 = 0.0002;
/// A clip whose last 200 ms (median, so a click at release doesn't count)
/// sit at or under this RMS (≈ −74 dBFS) may end in a noise gate: digital
/// silence, dither, or room noise lowered 20 dB.
const GATED_MAX_RMS: f32 = 0.0002;
/// The gated stretch: frames up to this many times the level of the last
/// 200 ms (+6 dB), or `GATED_MAX_RMS`, whichever is higher.
const GATED_MARGIN: f32 = 2.0;
/// Before a gate: the floor times this (+8 dB). Room noise just before a
/// gate often swells or breathes, so it needs more margin not to count as
/// speech.
const GATED_NOISE_MARGIN: f32 = 2.5;
/// Before a gate the quiet level stays this far under the loud threshold
/// (−6 dB), so soft speech running into the gate still counts.
const GATED_QUIET_FACTOR: f32 = 0.5;
/// A clip whose last 200 ms (median) sit at or above this fraction of the
/// loud threshold (−6 dB) ends in soft speech, as when push-to-talk is
/// released mid trail-off. Of 4,585 trimmed QA clips, 111 ended within
/// 6 dB (96 of them in −46 dBFS room noise, now kept); 9 dB adds 3 more.
const ENDS_IN_SPEECH_FACTOR: f32 = 0.5;

/// Whether `levels` end within 6 dB of `threshold`, with no pause before
/// the end of the clip: the tail is soft speech, not room noise.
pub(super) fn ends_in_speech(levels: &[f32], threshold: f32) -> bool {
    median(last_window(levels)).is_some_and(|r| r >= threshold * ENDS_IN_SPEECH_FACTOR)
}

/// 6 dB over the noise floor of the frames after the loud anchor. If the
/// tail ends in a gate after 200 ms or more of sound, only the frames
/// before the gate set the floor (+8 dB), and the level stays 6 dB under
/// `threshold`, so soft speech running into the gate still counts. Without
/// a gate it is under `threshold` already: a tail within 6 dB of it ends in
/// speech and isn't trimmed.
pub(super) fn quiet_level(tail: &[f32], threshold: f32) -> f32 {
    match gate_start(tail) {
        Some(n) if n >= NOISE_FRAMES => {
            let quiet = floor(&tail[..n]) * GATED_NOISE_MARGIN;
            quiet.max(MIN_QUIET_RMS).min(threshold * GATED_QUIET_FACTOR)
        }
        _ => (floor(tail) * NOISE_MARGIN).max(MIN_QUIET_RMS),
    }
}

/// The lowest `NOISE_PERCENTILE` over each 200 ms window of `levels` (over
/// all of them when shorter), or 0 for none.
fn floor(levels: &[f32]) -> f32 {
    levels
        .windows(NOISE_FRAMES.min(levels.len()).max(1))
        .filter_map(|w| percentile(w.to_vec(), NOISE_PERCENTILE))
        .reduce(f32::min)
        .unwrap_or(0.0)
}

/// Start of the gated stretch at the end of `tail`: the last 200 ms are at
/// or under `GATED_MAX_RMS`, and the stretch runs back to the last run of
/// `MIN_SPEECH_FRAMES` frames over `GATED_MARGIN` times that level, so a
/// click in the gate doesn't end it. `None` when the tail isn't gated.
fn gate_start(tail: &[f32]) -> Option<usize> {
    let level = median(last_window(tail))?;
    if level > GATED_MAX_RMS {
        return None;
    }
    let limit = (level * GATED_MARGIN).max(GATED_MAX_RMS);
    let mut run = 0;
    for (i, &r) in tail.iter().enumerate().rev() {
        run = if r > limit { run + 1 } else { 0 };
        if run == MIN_SPEECH_FRAMES {
            return Some(i + run);
        }
    }
    Some(0)
}

fn last_window(levels: &[f32]) -> &[f32] {
    &levels[levels.len().saturating_sub(NOISE_FRAMES)..]
}

fn median(levels: &[f32]) -> Option<f32> {
    percentile(levels.to_vec(), 0.5)
}

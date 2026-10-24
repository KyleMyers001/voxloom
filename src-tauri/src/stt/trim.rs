//! BUS-139: trim the quiet tail of a clip before whisper.
//!
//! Whisper hallucinates "Thank you." or "you" over the silence or room noise
//! left after the last word. The trailing run of quiet 20 ms frames is cut
//! down to a short kept tail. Two levels decide where speech ends:
//!
//! - The loud anchor: the last run of loud frames, relative to the clip's
//!   own speech level with an absolute floor, so a higher noise floor still
//!   trims under much louder speech.
//! - The speech end: the last run at or above a quiet level 6 dB over the
//!   tail's own noise floor. A soft final word below the loud threshold
//!   still counts, so the kept tail starts after it, not inside it. When a
//!   noise gate cuts recorded room noise to (near) digital silence, the
//!   floor is the quietest 200 ms before the gate, so that noise doesn't
//!   count as speech, and soft speech running into the gate still does.
//!
//! Both need 80 ms of frames (one 20 ms dip per run), so a click or key
//! thump in the tail doesn't count as speech. A lone 60–79 ms sound after
//! the last such run is cut, so about 3% of random clips keep less than
//! with 60 ms runs.

use super::gate::AudioStats;

const FRAME_MS: usize = 20;
/// Tail kept after the speech end. Whisper drops a short final word ("okay",
/// "thanks") that ends 250–500 ms before the clip end; at 1000 ms "Thank
/// you" comes back. 750 ms kept every final word in the QA tail sweep.
const KEPT_TAIL_MS: usize = 750;
/// Frames in a row needed to count as speech (80 ms). A thump of up to
/// 40 ms touches at most 3 frames (41–60 ms can touch 4, by alignment); a
/// short word like "so" lasts well over 80 ms.
const MIN_SPEECH_FRAMES: usize = 4;
/// Frames at or above this RMS (≈ −44 dBFS) may be speech. Hallucinated
/// tails measured 0.0000–0.0011 RMS in the BUS-139 harness.
const ABSOLUTE_FLOOR_RMS: f32 = 0.006;
/// Speech level: this percentile of the possible-speech frames.
const SPEECH_PERCENTILE: f32 = 0.9;
/// Loud is at or above this fraction (≈ −30 dB) of the speech level. Only
/// speech louder than 0.2 RMS (≈ −14 dBFS) gets a threshold above the
/// floor; quieter dictation uses the floor, and its soft final words rely
/// on the quiet level below.
const RELATIVE_FACTOR: f32 = 0.03;
/// Tail noise floor: this percentile of the frames after the loud anchor.
/// Low, so a soft final word longer than the noise doesn't set it.
const NOISE_PERCENTILE: f32 = 0.2;
/// Quiet level: the noise floor times this (+6 dB).
const NOISE_MARGIN: f32 = 2.0;
/// Lowest quiet level (≈ −74 dBFS), for a digitally silent tail. A final
/// word 32 dB under −30 dBFS speech sits near −62 dBFS.
const MIN_QUIET_RMS: f32 = 0.0002;
/// A clip whose last 200 ms sit at or under this RMS (≈ −74 dBFS) may end
/// in a noise gate: digital silence, dither, or room noise lowered 20 dB.
const GATED_MAX_RMS: f32 = 0.0002;
/// The gated stretch: frames up to this many times the level of the last
/// 200 ms (+6 dB), or one 16-bit LSB, whichever is higher.
const GATED_MARGIN: f32 = 2.0;
const LSB_RMS: f32 = 1.0 / 32_768.0;
/// Window for the noise floor before a gate (200 ms).
const NOISE_FRAMES: usize = 10;
/// Quiet level before a gate: the floor times this (+8 dB). The quietest
/// window reads lower than the whole tail, so a breath or noise swell just
/// before the gate needs more margin not to count as speech.
const GATED_NOISE_MARGIN: f32 = 2.5;
/// Before a gate the quiet level stays this far under the loud threshold
/// (−6 dB), so soft speech running into the gate still counts.
const GATED_QUIET_FACTOR: f32 = 0.5;

/// What `trailing_trim` decided for one clip.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TailTrim {
    /// Samples to keep from the start of the clip.
    pub keep_len: usize,
    /// RMS of the trailing quiet run (0 when there is none).
    pub tail_rms: f32,
    /// Frame RMS at or above which a run counts as loud speech.
    pub threshold: f32,
    /// Frame RMS at or above which a run counts as (soft) speech.
    pub quiet_level: f32,
}

impl TailTrim {
    /// Milliseconds removed from a clip of `total_len` samples. Only the
    /// debug-build log uses it, so it is not compiled into release.
    #[cfg(any(debug_assertions, test))]
    pub fn trimmed_ms(&self, total_len: usize, sample_rate_hz: u32) -> u64 {
        let removed = total_len.saturating_sub(self.keep_len) as u64;
        removed * 1000 / u64::from(sample_rate_hz.max(1))
    }
}

/// Decide how much of `samples` to keep. Clips with no frame above the
/// absolute floor, or with a quiet tail no longer than the kept tail, are
/// left unchanged. Never trims to empty.
pub fn trailing_trim(samples: &[f32], sample_rate_hz: u32) -> TailTrim {
    let ms = |n: usize| (sample_rate_hz as usize * n / 1000).max(1);
    let frame = ms(FRAME_MS);
    let levels: Vec<f32> = samples
        .chunks(frame)
        .map(|f| AudioStats::measure(f).rms)
        .collect();
    let unchanged = |threshold, quiet_level| TailTrim {
        keep_len: samples.len(),
        tail_rms: 0.0,
        threshold,
        quiet_level,
    };
    let Some(speech) = speech_level(&levels) else {
        return unchanged(ABSOLUTE_FLOOR_RMS, ABSOLUTE_FLOOR_RMS);
    };
    let threshold = (speech * RELATIVE_FACTOR).max(ABSOLUTE_FLOOR_RMS);
    let Some(loud_end) = speech_end(&levels, threshold) else {
        return unchanged(threshold, threshold);
    };
    let quiet_level = quiet_level(&levels[loud_end..], threshold);
    // The loud run is at or above the quiet level too, so this ends at or
    // after `loud_end`.
    let end_frame = speech_end(&levels, quiet_level).unwrap_or(loud_end);
    let quiet_start = (end_frame * frame).min(samples.len());
    let tail_rms = if quiet_start == samples.len() {
        0.0
    } else {
        AudioStats::measure(&samples[quiet_start..]).rms
    };
    TailTrim {
        keep_len: (quiet_start + ms(KEPT_TAIL_MS)).min(samples.len()),
        tail_rms,
        threshold,
        quiet_level,
    }
}

/// 6 dB over the noise floor of the frames after the loud anchor, at most
/// `threshold`. If the tail ends in a gate after 200 ms or more of sound,
/// the quietest 200 ms before the gate set the floor (+8 dB), and the level
/// stays 6 dB under `threshold`.
fn quiet_level(tail: &[f32], threshold: f32) -> f32 {
    let quiet = |noise: f32, margin: f32| (noise * margin).max(MIN_QUIET_RMS);
    match gate_start(tail) {
        Some(n) if n >= NOISE_FRAMES => {
            let noise = tail[..n]
                .windows(NOISE_FRAMES)
                .filter_map(|w| percentile(w.to_vec(), NOISE_PERCENTILE))
                .fold(f32::INFINITY, f32::min);
            quiet(noise, GATED_NOISE_MARGIN).min(threshold * GATED_QUIET_FACTOR)
        }
        _ => {
            let noise = percentile(tail.to_vec(), NOISE_PERCENTILE).unwrap_or(0.0);
            quiet(noise, NOISE_MARGIN).min(threshold)
        }
    }
}

/// Start of the gated stretch at the end of `tail`: the last 200 ms are at
/// or under `GATED_MAX_RMS`, and the stretch runs back while frames stay
/// within `GATED_MARGIN` of that level. `None` when the tail isn't gated.
fn gate_start(tail: &[f32]) -> Option<usize> {
    let last = &tail[tail.len().saturating_sub(NOISE_FRAMES)..];
    let level = last.iter().copied().fold(0.0, f32::max);
    if level > GATED_MAX_RMS {
        return None;
    }
    let limit = (level * GATED_MARGIN).max(LSB_RMS);
    Some(tail.iter().rposition(|&r| r > limit).map_or(0, |i| i + 1))
}

/// Frame index just past the last run of `MIN_SPEECH_FRAMES` or more frames
/// at or above `threshold`. `None` when there is no such run. A run may
/// bridge one frame under it, like the closure before the burst of a fast
/// "it"; a second such frame, adjacent or not, ends the run.
fn speech_end(levels: &[f32], threshold: f32) -> Option<usize> {
    let (mut run, mut end, mut dipped) = (0, 0, false);
    for (i, &r) in levels.iter().enumerate().rev() {
        if r >= threshold {
            if run == 0 {
                end = i + 1;
            }
            run += 1;
            if run == MIN_SPEECH_FRAMES {
                return Some(end);
            }
        } else if run > 0 && !dipped {
            dipped = true;
        } else {
            run = 0;
            dipped = false;
        }
    }
    None
}

/// The given percentile of the frames at or above the absolute floor.
fn speech_level(levels: &[f32]) -> Option<f32> {
    let loud: Vec<f32> = levels
        .iter()
        .copied()
        .filter(|&r| r >= ABSOLUTE_FLOOR_RMS)
        .collect();
    percentile(loud, SPEECH_PERCENTILE)
}

/// The `p` percentile (nearest rank, rounded) of `values`.
fn percentile(mut values: Vec<f32>, p: f32) -> Option<f32> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f32::total_cmp);
    let index = ((values.len() - 1) as f32 * p).round() as usize;
    Some(values[index])
}

#[cfg(test)]
#[path = "trim_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "trim_pipeline_tests.rs"]
mod pipeline_tests;

#[cfg(all(test, feature = "whisper"))]
#[path = "trim_model_tests.rs"]
mod model_tests;

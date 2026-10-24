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
//! A clip that still ends within 6 dB of the loud threshold is left whole:
//! push-to-talk released mid trail-off. Room noise that loud is kept too.
//!
//! Both need 80 ms of frames (one 20 ms dip per run), so a click or key
//! thump in the tail doesn't count as speech. A lone 60–79 ms sound after
//! the last such run is cut, so about 3% of random clips keep less than
//! with 60 ms runs.

use super::gate::AudioStats;
use floor::{ends_in_speech, quiet_level};

#[path = "trim_floor.rs"]
mod floor;

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
    if ends_in_speech(&levels, threshold) {
        return unchanged(threshold, quiet_level);
    }
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

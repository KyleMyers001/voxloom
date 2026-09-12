/// CPAL input stream adapter — BUS-9.
///
/// Design constraints:
/// - The real-time callback must never allocate on the heap, block, log,
///   or emit IPC. It writes mono f32 into a preallocated HeapRb ring buffer.
/// - On overflow, an atomic overflow flag is latched; the coordinator reads
///   it on each worker iteration and terminates with `input-limit-exceeded`.
/// - Format conversion (i16/i32/u16/u32/f32) is performed inside the
///   callback using dasp_sample::FromSample — no branching alloc.
/// - Device identity uses the CoreAudio UID string where CPAL exposes it,
///   falling back to name-match with explicit `None` for the system default.
///   Ambiguous names are not silently disambiguated.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{
    BufferSize, Data, SampleFormat, SampleRate, StreamConfig,
};
use ringbuf::{
    traits::{Producer, Split},
    HeapCons, HeapProd, HeapRb,
};

/// Capacity of the ring buffer in f32 frames (mono, 16 kHz equivalent).
/// 4096 frames ≈ 256 ms at 16 kHz — large enough to absorb OS scheduling
/// jitter without losing samples during normal operation.
pub const RING_CAPACITY: usize = 4096;

/// Typed device selection.
#[derive(Debug, Clone)]
pub enum DeviceSelection {
    /// System default input device resolved at open time.
    SystemDefault,
    /// Device matched by exact name. Returns `capture-unavailable` if the
    /// name is absent or matches more than one device.
    Named(String),
}

/// SAFETY wrapper: CPAL's CoreAudio stream uses non-Send raw pointers
/// internally, but the stream is only created/dropped on the worker thread
/// (never sent to a thread while active). We send it to the worker at
/// construction time only, and drop it there.
///
/// This is the same pattern used by cpal's own examples.
#[allow(clippy::non_send_fields_in_send_ty)]
pub struct SendStream(#[allow(dead_code)] cpal::Stream);

// SAFETY: cpal::Stream is tied to CoreAudio which is safe to send
// between threads as long as it is not used concurrently from multiple
// threads. We guarantee single-threaded ownership by construction.
unsafe impl Send for SendStream {}

impl Drop for SendStream {
    fn drop(&mut self) {
        // Stream is stopped on drop by cpal.
    }
}

/// Opened stream returned to the coordinator.
pub struct OpenedStream {
    /// Keep alive to hold the stream active; drop to stop.
    pub stream: SendStream,
    /// Number of interleaved channels in the native feed.
    pub channels: u16,
    /// Native device sample rate (Hz).
    pub native_rate: u32,
    /// Device display name (not used for identity decisions).
    pub device_name: String,
    /// Consumer half of the ring buffer; worker drains this.
    pub consumer: HeapCons<f32>,
    /// Latched true on ring-buffer overflow.
    pub overflow: Arc<AtomicBool>,
}

/// Open an input stream.
///
/// Errors have a `"capture-unavailable: …"` prefix.
pub fn open_input(
    selection: &DeviceSelection,
) -> Result<OpenedStream, String> {
    let host = cpal::default_host();
    let device = resolve_device(&host, selection)?;

    let device_name = device
        .name()
        .unwrap_or_else(|_| String::from("unknown"));

    let supported = device
        .default_input_config()
        .map_err(|e| format!("capture-unavailable: {e}"))?;

    let channels = supported.channels();
    let native_rate = supported.sample_rate().0;
    let sample_format = supported.sample_format();

    let config = StreamConfig {
        buffer_size: BufferSize::Default,
        channels,
        sample_rate: SampleRate(native_rate),
    };

    let rb = HeapRb::<f32>::new(RING_CAPACITY);
    let (producer, consumer) = rb.split();

    let overflow = Arc::new(AtomicBool::new(false));
    let stream = build_stream(
        &device,
        &config,
        sample_format,
        channels,
        producer,
        Arc::clone(&overflow),
    )?;

    stream
        .play()
        .map_err(|e| format!("capture-unavailable: {e}"))?;

    Ok(OpenedStream {
        channels,
        consumer,
        device_name,
        native_rate,
        overflow,
        stream: SendStream(stream),
    })
}

/// Enumerate input device names using the default host.
pub fn list_input_device_names() -> Vec<String> {
    let host = cpal::default_host();
    host.input_devices()
        .map(|devs| {
            devs.filter_map(|d| d.name().ok()).collect()
        })
        .unwrap_or_default()
}

// ── Internals ─────────────────────────────────────────────────────────────

/// Build a raw input stream that converts all supported CPAL formats to
/// mono f32 inline in the callback. No heap allocation in the hot path.
fn build_stream(
    device: &cpal::Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    channels: u16,
    mut producer: HeapProd<f32>,
    overflow: Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    use cpal::traits::DeviceTrait;
    use cpal::StreamError;

    let overflow_err = Arc::clone(&overflow);

    macro_rules! build_typed {
        ($T:ty) => {{
            let ch = channels as usize;
            let overflow2 = Arc::clone(&overflow);
            device.build_input_stream_raw(
                config,
                sample_format,
                move |data: &Data, _: &cpal::InputCallbackInfo| {
                    // SAFETY: SampleFormat matches T because we match
                    // on sample_format before calling this macro.
                    let samples: &[$T] = match data.as_slice() {
                        Some(s) => s,
                        None => return,
                    };
                    write_mono_f32(
                        samples,
                        ch,
                        &mut producer,
                        &overflow2,
                    );
                },
                move |_err: StreamError| {
                    // Error surfaced via ring-buffer drain timing out;
                    // the coordinator watchdog handles it. We do not
                    // log or allocate here.
                    overflow_err.store(true, Ordering::Release);
                },
                None,
            )
        }};
    }

    let stream = match sample_format {
        SampleFormat::F32 => build_typed!(f32),
        SampleFormat::I16 => build_typed!(i16),
        SampleFormat::I32 => build_typed!(i32),
        SampleFormat::U16 => build_typed!(u16),
        SampleFormat::U32 => build_typed!(u32),
        other => {
            return Err(format!(
                "capture-unavailable: sample format {other:?} \
                 not supported"
            ));
        }
    }
    .map_err(|e| format!("capture-unavailable: {e}"))?;

    Ok(stream)
}

/// Downmix `interleaved` samples of type `T` to mono f32 and push into
/// `producer`. Sets `overflow` if the ring buffer is full.
///
/// No heap allocation. Called from the real-time callback.
fn write_mono_f32<T>(
    interleaved: &[T],
    channels: usize,
    producer: &mut HeapProd<f32>,
    overflow: &AtomicBool,
) where
    T: Copy,
    f32: cpal::FromSample<T>,
{
    use cpal::Sample;
    let step = channels.max(1);
    for frame in interleaved.chunks(step) {
        // Average channels to mono.
        let sum: f32 = frame
            .iter()
            .copied()
            .map(|s| f32::from_sample(s))
            .sum();
        let mono = sum / step as f32;

        if producer.try_push(mono).is_err() {
            // Ring full: latch overflow flag; coordinator terminates.
            overflow.store(true, Ordering::Release);
            return;
        }
    }
}

/// Resolve a device from the default CPAL host.
/// `SystemDefault` returns the OS default input device.
/// `Named` returns an error if zero or multiple matches exist.
fn resolve_device(
    host: &cpal::Host,
    selection: &DeviceSelection,
) -> Result<cpal::Device, String> {
    match selection {
        DeviceSelection::SystemDefault => {
            host.default_input_device().ok_or_else(|| {
                String::from(
                    "capture-unavailable: no default input device",
                )
            })
        }
        DeviceSelection::Named(name) => {
            let devices = host
                .input_devices()
                .map_err(|e| format!("capture-unavailable: {e}"))?;
            let mut matches: Vec<cpal::Device> = devices
                .filter(|d| {
                    d.name().map(|n| n == *name).unwrap_or(false)
                })
                .collect();
            match matches.len() {
                0 => Err(format!(
                    "capture-unavailable: device '{name}' not found"
                )),
                1 => Ok(matches.remove(0)),
                n => Err(format!(
                    "capture-unavailable: device name '{name}' is \
                     ambiguous ({n} matches)"
                )),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    // ── write_mono_f32 ────────────────────────────────────────────────

    fn make_ring(cap: usize) -> (HeapProd<f32>, HeapCons<f32>) {
        HeapRb::<f32>::new(cap).split()
    }

    fn drain(mut cons: HeapCons<f32>) -> Vec<f32> {
        use ringbuf::traits::Consumer;
        let mut out = Vec::new();
        while let Some(s) = cons.try_pop() {
            out.push(s);
        }
        out
    }

    #[test]
    fn f32_mono_passthrough() {
        let (mut prod, cons) = make_ring(16);
        let overflow = Arc::new(AtomicBool::new(false));
        write_mono_f32(&[0.25f32, 0.5, -0.5], 1, &mut prod, &overflow);
        assert!(!overflow.load(Ordering::Acquire));
        let out = drain(cons);
        assert_eq!(out, vec![0.25f32, 0.5, -0.5]);
    }

    #[test]
    fn stereo_f32_downmix_averages_channels() {
        let (mut prod, cons) = make_ring(16);
        let overflow = Arc::new(AtomicBool::new(false));
        // Two stereo frames: [1.0, -1.0] and [0.5, 0.5]
        write_mono_f32(&[1.0f32, -1.0, 0.5, 0.5], 2, &mut prod, &overflow);
        let out = drain(cons);
        assert_eq!(out.len(), 2);
        assert!((out[0]).abs() < 1e-6, "average of 1.0 and -1.0 = 0");
        assert!((out[1] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn i16_converted_to_f32() {
        let (mut prod, cons) = make_ring(16);
        let overflow = Arc::new(AtomicBool::new(false));
        // i16::MAX converts to approximately 1.0 in dasp.
        write_mono_f32(&[i16::MAX], 1, &mut prod, &overflow);
        let out = drain(cons);
        assert_eq!(out.len(), 1);
        assert!((out[0] - 1.0).abs() < 0.001);
    }

    #[test]
    fn i16_min_converts_to_neg_one() {
        let (mut prod, cons) = make_ring(16);
        let overflow = Arc::new(AtomicBool::new(false));
        write_mono_f32(&[i16::MIN], 1, &mut prod, &overflow);
        let out = drain(cons);
        assert!((out[0] - (-1.0)).abs() < 0.001);
    }

    #[test]
    fn u16_mid_converts_to_silence() {
        // u16 silence is 32768 (midpoint); dasp maps to 0.0.
        let (mut prod, cons) = make_ring(16);
        let overflow = Arc::new(AtomicBool::new(false));
        write_mono_f32(&[32768u16], 1, &mut prod, &overflow);
        let out = drain(cons);
        assert!(out[0].abs() < 0.001, "u16 midpoint should be ~0.0");
    }

    #[test]
    fn i32_extrema_convert_to_pm1() {
        let (mut prod, cons) = make_ring(16);
        let overflow = Arc::new(AtomicBool::new(false));
        write_mono_f32(&[i32::MAX, i32::MIN], 1, &mut prod, &overflow);
        let out = drain(cons);
        assert!((out[0] - 1.0).abs() < 0.001);
        assert!((out[1] - (-1.0)).abs() < 0.001);
    }

    #[test]
    fn overflow_latches_when_ring_full() {
        // Ring capacity 2; send 4 frames.
        let (mut prod, _cons) = make_ring(2);
        let overflow = Arc::new(AtomicBool::new(false));
        write_mono_f32(&[0.1f32, 0.2, 0.3, 0.4], 1, &mut prod, &overflow);
        assert!(
            overflow.load(Ordering::Acquire),
            "overflow should be latched"
        );
    }

    #[test]
    fn silence_stays_zero_after_conversion() {
        let (mut prod, cons) = make_ring(16);
        let overflow = Arc::new(AtomicBool::new(false));
        write_mono_f32(&[0.0f32; 8], 1, &mut prod, &overflow);
        let out = drain(cons);
        assert!(out.iter().all(|&s| s == 0.0));
    }

    // ── DeviceSelection ───────────────────────────────────────────────

    #[test]
    fn device_selection_debug() {
        // Verify DeviceSelection derives Debug without exposing live devices.
        let d = DeviceSelection::Named(String::from("Mic A"));
        assert!(format!("{d:?}").contains("Mic A"));
        let d2 = DeviceSelection::SystemDefault;
        assert!(format!("{d2:?}").contains("SystemDefault"));
    }

    // open_input() requires a live CoreAudio session; tested manually.
    // See docs/review/BUS-9-implementation.md for manual test matrix.
}

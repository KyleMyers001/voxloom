/// CPAL input stream adapter — BUS-9.
///
/// Design constraints:
/// - The real-time callback must never allocate on the heap, block, log,
///   or emit IPC. It writes mono f32 into a preallocated HeapRb ring buffer.
/// - On ring overflow, `overflow_flag` latches true; coordinator terminates
///   with `input-limit-exceeded`. On device error, `error_flag` latches true;
///   coordinator terminates with `capture-unavailable`. The two flags are
///   distinct so error category is correct.
/// - Format conversion (i16/i32/u16/u32/f32) uses `dasp_sample::FromSample`
///   inside the callback — no branching allocation.
/// - `cpal::Stream` is !Send on macOS; it is opened and dropped exclusively
///   on the worker thread via `with_stream`. No unsafe Send impl is used.
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{
    BufferSize, Data, SampleFormat, SampleRate, StreamConfig,
};
use ringbuf::{
    traits::{Producer, Split},
    HeapCons, HeapProd, HeapRb,
};

/// Capacity of the ring buffer in f32 mono frames.
/// 4096 frames ≈ 256 ms at 16 kHz.
pub const RING_CAPACITY: usize = 4096;

/// Typed device selection.
#[derive(Debug, Clone)]
pub enum DeviceSelection {
    /// System default input device resolved at open time.
    SystemDefault,
    /// First device whose name matches exactly; errors if zero or multiple.
    Named(String),
}

/// Metadata returned with the ring consumer when a stream is opened.
pub struct StreamMeta {
    /// True while the real-time callback may accept new frames.
    pub accepting: Arc<AtomicBool>,
    /// Number of callbacks currently writing accepted frames.
    pub callbacks_in_flight: Arc<AtomicUsize>,
    /// Display name only — not identity.
    pub device_name: String,
    /// Native device sample rate in Hz.
    pub native_rate: u32,
    /// Consumer half of the ring; worker drains this.
    pub consumer: HeapCons<f32>,
    /// Latched true on ring-buffer overflow (input-limit-exceeded).
    pub overflow: Arc<AtomicBool>,
    /// Latched true on device/stream error (capture-unavailable).
    pub stream_error: Arc<AtomicBool>,
}

/// Open an input stream, call `f` with stream metadata while the stream
/// is alive, then close the stream when `f` returns.
///
/// `cpal::Stream` never crosses thread boundaries. Call this function
/// from the thread that will own and drop the stream.
///
/// Errors have a `"capture-unavailable: …"` prefix.
pub fn with_stream<F, R>(
    selection: &DeviceSelection,
    f: F,
) -> Result<R, String>
where
    F: FnOnce(StreamMeta) -> R,
{
    let host = cpal::default_host();
    let device = resolve_device(&host, selection)?;

    let device_name = device
        .name()
        .unwrap_or_else(|_| String::from("unknown"));

    let supported = device
        .default_input_config()
        .map_err(|e| format!("capture-unavailable: {e}"))?;

    let native_rate = supported.sample_rate().0;
    let sample_format = supported.sample_format();
    let channels = supported.channels();

    let config = StreamConfig {
        buffer_size: BufferSize::Default,
        channels,
        sample_rate: SampleRate(native_rate),
    };

    let rb = HeapRb::<f32>::new(RING_CAPACITY);
    let (producer, consumer) = rb.split();

    let overflow = Arc::new(AtomicBool::new(false));
    let stream_error = Arc::new(AtomicBool::new(false));
    let accepting = Arc::new(AtomicBool::new(true));
    let callbacks_in_flight = Arc::new(AtomicUsize::new(0));

    // Build the stream — stays local to this function's stack frame.
    let stream = build_stream(
        &device,
        &config,
        sample_format,
        channels,
        producer,
        Arc::clone(&accepting),
        Arc::clone(&callbacks_in_flight),
        Arc::clone(&overflow),
        Arc::clone(&stream_error),
    )?;

    stream
        .play()
        .map_err(|e| format!("capture-unavailable: {e}"))?;

    let meta = StreamMeta {
        accepting,
        callbacks_in_flight,
        consumer,
        device_name,
        native_rate,
        overflow,
        stream_error,
    };

    let result = f(meta);

    // Stream dropped here — explicitly after f returns.
    drop(stream);
    Ok(result)
}

/// Enumerate input device names using the default host.
pub fn list_input_device_names() -> Vec<String> {
    let host = cpal::default_host();
    host.input_devices()
        .map(|devs| devs.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default()
}

// Internals

/// Build a raw input stream, converting all supported CPAL sample formats
/// to mono f32 inside the callback.
///
/// Supported: F32, I16, I32, U16, U32.
/// Unsupported (F64, I8, U8, I64, U64, I24, U24, I48, U48): returns Err.
/// CPAL 0.15 does not expose all possible formats on CoreAudio — the
/// actually-supported set is constrained by the host; we handle the formats
/// CPAL 0.15 documents for CoreAudio and fail closed on the rest.
fn build_stream(
    device: &cpal::Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    channels: u16,
    mut producer: HeapProd<f32>,
    accepting: Arc<AtomicBool>,
    callbacks_in_flight: Arc<AtomicUsize>,
    overflow: Arc<AtomicBool>,
    stream_error: Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    use cpal::StreamError;

    macro_rules! build_typed {
        ($T:ty) => {{
            let ch = channels as usize;
            let accepting2 = Arc::clone(&accepting);
            let in_flight2 = Arc::clone(&callbacks_in_flight);
            let of2 = Arc::clone(&overflow);
            let se2 = Arc::clone(&stream_error);
            device.build_input_stream_raw(
                config,
                sample_format,
                move |data: &Data, _: &cpal::InputCallbackInfo| {
                    let samples: &[$T] = match data.as_slice() {
                        Some(s) => s,
                        None => return,
                    };
                    write_mono_f32(
                        samples,
                        ch,
                        &mut producer,
                        &accepting2,
                        &in_flight2,
                        &of2,
                    );
                },
                move |_err: StreamError| {
                    // Device disconnect or revocation is distinct from
                    // overflow.
                    se2.store(true, Ordering::Release);
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
                "capture-unavailable: sample format {other:?} not \
                 supported (F64/I8/U8/I64/U64/I24/U24/I48/U48 are \
                 not handled; CPAL 0.15 CoreAudio typically reports \
                 F32 or integer variants listed above)"
            ));
        }
    }
    .map_err(|e| format!("capture-unavailable: {e}"))?;

    Ok(stream)
}

/// Downmix `interleaved` samples of type `T` to mono f32 and push into
/// `producer`. Sets `overflow` when the ring buffer is full.
/// Must not allocate, block, or log — called from the real-time callback.
fn write_mono_f32<T>(
    interleaved: &[T],
    channels: usize,
    producer: &mut HeapProd<f32>,
    accepting: &AtomicBool,
    callbacks_in_flight: &AtomicUsize,
    overflow: &AtomicBool,
) where
    T: Copy,
    f32: cpal::FromSample<T>,
{
    use cpal::Sample;
    // These two atomics form one close/lease protocol. SeqCst is required
    // for every operation so the closer cannot observe an old lease count
    // while this callback observes the old accepting state.
    callbacks_in_flight.fetch_add(1, Ordering::SeqCst);
    let _lease = CallbackLease(callbacks_in_flight);
    if !accepting.load(Ordering::SeqCst) {
        return;
    }
    let step = channels.max(1);
    for frame in interleaved.chunks(step) {
        let sum: f32 =
            frame.iter().copied().map(|s| f32::from_sample(s)).sum();
        let mono = sum / step as f32;
        if producer.try_push(mono).is_err() {
            overflow.store(true, Ordering::Release);
            return;
        }
    }
}

struct CallbackLease<'a>(&'a AtomicUsize);

impl Drop for CallbackLease<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Resolve a device from the default CPAL host.
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
                    "capture-unavailable: device '{name}' not found; \
                     note: device names are display labels only, not \
                     stable identifiers — connect the device and \
                     verify the name"
                )),
                1 => Ok(matches.remove(0)),
                n => Err(format!(
                    "capture-unavailable: device name '{name}' is \
                     ambiguous ({n} devices match); name-based \
                     selection cannot disambiguate duplicate names"
                )),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

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

    fn open_gate() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(true))
    }

    fn no_callbacks() -> AtomicUsize {
        AtomicUsize::new(0)
    }

    // write_mono_f32

    #[test]
    fn f32_mono_passthrough() {
        let (mut prod, cons) = make_ring(16);
        let ov = Arc::new(AtomicBool::new(false));
        write_mono_f32(
            &[0.25f32, 0.5, -0.5],
            1,
            &mut prod,
            &open_gate(),
            &no_callbacks(),
            &ov,
        );
        assert!(!ov.load(Ordering::Acquire));
        assert_eq!(drain(cons), vec![0.25f32, 0.5, -0.5]);
    }

    #[test]
    fn stereo_f32_downmix_averages_to_zero() {
        let (mut prod, cons) = make_ring(16);
        let ov = Arc::new(AtomicBool::new(false));
        // [1.0, -1.0] → avg 0.0; [0.5, 0.5] → avg 0.5
        write_mono_f32(
            &[1.0f32, -1.0, 0.5, 0.5],
            2,
            &mut prod,
            &open_gate(),
            &no_callbacks(),
            &ov,
        );
        let out = drain(cons);
        assert_eq!(out.len(), 2);
        assert!(out[0].abs() < 1e-6);
        assert!((out[1] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn i16_max_converts_near_plus_one() {
        let (mut prod, cons) = make_ring(4);
        let ov = Arc::new(AtomicBool::new(false));
        write_mono_f32(
            &[i16::MAX],
            1,
            &mut prod,
            &open_gate(),
            &no_callbacks(),
            &ov,
        );
        let out = drain(cons);
        assert!((out[0] - 1.0).abs() < 0.001);
    }

    #[test]
    fn i16_min_converts_near_minus_one() {
        let (mut prod, cons) = make_ring(4);
        let ov = Arc::new(AtomicBool::new(false));
        write_mono_f32(
            &[i16::MIN],
            1,
            &mut prod,
            &open_gate(),
            &no_callbacks(),
            &ov,
        );
        let out = drain(cons);
        assert!((out[0] - (-1.0)).abs() < 0.001);
    }

    #[test]
    fn u16_midpoint_converts_near_zero() {
        let (mut prod, cons) = make_ring(4);
        let ov = Arc::new(AtomicBool::new(false));
        write_mono_f32(
            &[32768u16],
            1,
            &mut prod,
            &open_gate(),
            &no_callbacks(),
            &ov,
        );
        let out = drain(cons);
        assert!(out[0].abs() < 0.001, "u16 midpoint maps to ~0.0");
    }

    #[test]
    fn i32_extrema_convert_to_pm1() {
        let (mut prod, cons) = make_ring(4);
        let ov = Arc::new(AtomicBool::new(false));
        write_mono_f32(
            &[i32::MAX, i32::MIN],
            1,
            &mut prod,
            &open_gate(),
            &no_callbacks(),
            &ov,
        );
        let out = drain(cons);
        assert!((out[0] - 1.0).abs() < 0.001);
        assert!((out[1] - (-1.0)).abs() < 0.001);
    }

    #[test]
    fn u32_midpoint_converts_near_zero() {
        let (mut prod, cons) = make_ring(4);
        let ov = Arc::new(AtomicBool::new(false));
        write_mono_f32(
            &[u32::MAX / 2],
            1,
            &mut prod,
            &open_gate(),
            &no_callbacks(),
            &ov,
        );
        let out = drain(cons);
        assert!(out[0].abs() < 0.001, "u32 midpoint maps to ~0.0");
    }

    #[test]
    fn overflow_flag_latches_when_ring_full() {
        let (mut prod, _cons) = make_ring(2);
        let ov = Arc::new(AtomicBool::new(false));
        write_mono_f32(
            &[0.1f32, 0.2, 0.3, 0.4],
            1,
            &mut prod,
            &open_gate(),
            &no_callbacks(),
            &ov,
        );
        assert!(ov.load(Ordering::Acquire));
    }

    #[test]
    fn silence_produces_zero_frames() {
        let (mut prod, cons) = make_ring(16);
        let ov = Arc::new(AtomicBool::new(false));
        write_mono_f32(
            &[0.0f32; 8],
            1,
            &mut prod,
            &open_gate(),
            &no_callbacks(),
            &ov,
        );
        let out = drain(cons);
        assert!(out.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn closed_gate_discards_frames_without_overflow() {
        let (mut producer, consumer) = make_ring(2);
        let accepting = AtomicBool::new(false);
        let callbacks_in_flight = AtomicUsize::new(0);
        let overflow = AtomicBool::new(false);
        write_mono_f32(
            &[0.1f32, 0.2, 0.3],
            1,
            &mut producer,
            &accepting,
            &callbacks_in_flight,
            &overflow,
        );
        assert!(drain(consumer).is_empty());
        assert_eq!(callbacks_in_flight.load(Ordering::SeqCst), 0);
        assert!(!overflow.load(Ordering::Acquire));
    }

    #[derive(Clone, Copy, Debug)]
    enum GateOperation {
        CallbackAcquire,
        CallbackCheck,
        CallbackRelease,
        CloserClose,
        CloserCheck,
    }

    fn legal_gate_orders(
        prefix: &mut Vec<GateOperation>,
        callback_step: usize,
        closer_step: usize,
        orders: &mut Vec<Vec<GateOperation>>,
    ) {
        const CALLBACK: [GateOperation; 3] = [
            GateOperation::CallbackAcquire,
            GateOperation::CallbackCheck,
            GateOperation::CallbackRelease,
        ];
        const CLOSER: [GateOperation; 2] = [
            GateOperation::CloserClose,
            GateOperation::CloserCheck,
        ];

        if callback_step == CALLBACK.len() && closer_step == CLOSER.len() {
            orders.push(prefix.clone());
            return;
        }
        if callback_step < CALLBACK.len() {
            prefix.push(CALLBACK[callback_step]);
            legal_gate_orders(
                prefix,
                callback_step + 1,
                closer_step,
                orders,
            );
            prefix.pop();
        }
        if closer_step < CLOSER.len() {
            prefix.push(CLOSER[closer_step]);
            legal_gate_orders(
                prefix,
                callback_step,
                closer_step + 1,
                orders,
            );
            prefix.pop();
        }
    }

    #[test]
    fn seqcst_gate_model_covers_all_legal_interleavings() {
        let mut orders = Vec::new();
        legal_gate_orders(&mut Vec::new(), 0, 0, &mut orders);
        assert_eq!(orders.len(), 10);

        for order in orders {
            let mut accepting = true;
            let mut callback_accepted = false;
            let mut callback_completed = false;
            let mut leases = 0usize;
            let mut closer_safe = false;

            for operation in &order {
                match operation {
                    GateOperation::CallbackAcquire => leases += 1,
                    GateOperation::CallbackCheck => {
                        callback_accepted = accepting;
                    }
                    GateOperation::CallbackRelease => {
                        callback_completed = true;
                        leases -= 1;
                    }
                    GateOperation::CloserClose => accepting = false,
                    GateOperation::CloserCheck => {
                        closer_safe = !callback_accepted
                            || leases > 0
                            || callback_completed;
                    }
                }
            }

            assert!(
                closer_safe,
                "unsafe SeqCst interleaving: {order:?}",
            );
        }
    }

    // DeviceSelection debug

    #[test]
    fn device_selection_debug_shows_name() {
        let d = DeviceSelection::Named(String::from("Mic A"));
        assert!(format!("{d:?}").contains("Mic A"));
        let d2 = DeviceSelection::SystemDefault;
        assert!(format!("{d2:?}").contains("SystemDefault"));
    }

    // with_stream() requires live CoreAudio — manual test only.
}

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
use std::sync::{Arc, Mutex};

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
pub const SYSTEM_DEFAULT_ID: &str = "system-default";
const MAX_DEVICE_TOMBSTONES: usize = 32;

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
pub struct InputDeviceDescriptor {
    pub available: bool,
    pub id: String,
    pub label: String,
}

/// Typed device selection.
#[derive(Debug, Clone)]
pub enum DeviceSelection {
    /// System default input device resolved at open time.
    SystemDefault,
    /// Opaque process-local ID issued by `DeviceRegistry`.
    Id(String),
}

struct RegistryEntry<T> {
    descriptor: InputDeviceDescriptor,
    device: Option<T>,
}

struct RegistryState<T> {
    entries: Vec<RegistryEntry<T>>,
    next_id: u64,
}

impl<T> Default for RegistryState<T> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            next_id: 1,
        }
    }
}

pub struct DeviceRegistry {
    state: Mutex<RegistryState<cpal::Device>>,
}

impl DeviceRegistry {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(RegistryState::default()),
        }
    }

    pub fn list(&self) -> Result<Vec<InputDeviceDescriptor>, String> {
        refresh_registry(
            &self.state,
            enumerate_input_devices,
            same_native_device,
            |state| Ok(descriptors(state)),
        )
    }

    pub fn resolve(&self, id: &str) -> Result<cpal::Device, String> {
        refresh_registry(
            &self.state,
            enumerate_input_devices,
            same_native_device,
            |state| resolve_registered(state, id),
        )
    }
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
pub fn default_input_device() -> Result<cpal::Device, String> {
    cpal::default_host().default_input_device().ok_or_else(|| {
        String::from("capture-unavailable: no default input device")
    })
}

pub fn with_stream<F, R>(device: cpal::Device, f: F) -> Result<R, String>
where
    F: FnOnce(StreamMeta) -> R,
{
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

// Internals

fn descriptors<T>(state: &RegistryState<T>) -> Vec<InputDeviceDescriptor> {
    state
        .entries
        .iter()
        .map(|entry| entry.descriptor.clone())
        .collect()
}

fn enumerate_input_devices() -> Result<Vec<(cpal::Device, String)>, String> {
    cpal::default_host()
        .input_devices()
        .map_err(|error| format!("capture-unavailable: {error}"))?
        .map(|device| {
            let label = device
                .name()
                .unwrap_or_else(|_| String::from("Unknown microphone"));
            Ok((device, label))
        })
        .collect()
}

fn refresh_registry<T, R>(
    registry: &Mutex<RegistryState<T>>,
    enumerate: impl FnOnce() -> Result<Vec<(T, String)>, String>,
    same_device: impl Fn(&T, &T) -> bool,
    inspect: impl FnOnce(&RegistryState<T>) -> Result<R, String>,
) -> Result<R, String> {
    // Enumeration occurs while holding the registry lock. A slow older
    // snapshot therefore cannot reconcile after a newer list or resolve.
    let mut state = registry.lock().unwrap();
    let devices = enumerate()?;
    reconcile_devices(&mut state, devices, same_device);
    inspect(&state)
}

fn reconcile_devices<T>(
    state: &mut RegistryState<T>,
    mut devices: Vec<(T, String)>,
    same_device: impl Fn(&T, &T) -> bool,
) {
    for entry in state
        .entries
        .iter_mut()
        .filter(|entry| entry.descriptor.available)
    {
        let Some(current) = entry.device.as_ref() else {
            entry.descriptor.available = false;
            continue;
        };
        if let Some(position) = devices
            .iter()
            .position(|(device, _)| same_device(current, device))
        {
            let (device, label) = devices.remove(position);
            entry.descriptor.label = label;
            entry.device = Some(device);
        } else {
            // Once absence is observed, retire this ID permanently. This
            // prevents a reused CoreAudio AudioDeviceID from rebinding it.
            entry.descriptor.available = false;
            entry.device = None;
        }
    }
    for (device, label) in devices {
        let id = format!("input-{}", state.next_id);
        state.next_id += 1;
        state.entries.push(RegistryEntry {
            descriptor: InputDeviceDescriptor {
                available: true,
                id,
                label,
            },
            device: Some(device),
        });
    }
    prune_tombstones(state);
}

fn prune_tombstones<T>(state: &mut RegistryState<T>) {
    while state
        .entries
        .iter()
        .filter(|entry| !entry.descriptor.available)
        .count()
        > MAX_DEVICE_TOMBSTONES
    {
        if let Some(position) = state
            .entries
            .iter()
            .position(|entry| !entry.descriptor.available)
        {
            state.entries.remove(position);
        }
    }
}

fn resolve_registered<T: Clone>(
    state: &RegistryState<T>,
    id: &str,
) -> Result<T, String> {
    state
        .entries
        .iter()
        .find(|entry| entry.descriptor.id == id)
        .ok_or_else(|| {
            format!("capture-unavailable: unknown microphone id {id}")
        })
        .and_then(|entry| {
            entry.device.clone().ok_or_else(|| format!(
                "capture-unavailable: microphone {} is disconnected",
                entry.descriptor.label,
            ))
        })
}

#[cfg(target_os = "macos")]
fn same_native_device(left: &cpal::Device, right: &cpal::Device) -> bool {
    use cpal::platform::DeviceInner;

    match (left.as_inner(), right.as_inner()) {
        (DeviceInner::CoreAudio(left), DeviceInner::CoreAudio(right)) => {
            left == right
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn same_native_device(_left: &cpal::Device, _right: &cpal::Device) -> bool {
    false
}

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

    // Device registry

    fn descriptors<T>(state: &RegistryState<T>) -> Vec<InputDeviceDescriptor> {
        state
            .entries
            .iter()
            .map(|entry| entry.descriptor.clone())
            .collect()
    }

    #[test]
    fn duplicate_labels_receive_distinct_opaque_ids() {
        let mut state = RegistryState::default();
        reconcile_devices(
            &mut state,
            vec![(1, String::from("USB Mic")), (2, String::from("USB Mic"))],
            |left, right| left == right,
        );
        let listed = descriptors(&state);
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].label, listed[1].label);
        assert_ne!(listed[0].id, listed[1].id);
    }

    #[test]
    fn label_change_preserves_identity() {
        let mut state = RegistryState::default();
        reconcile_devices(
            &mut state,
            vec![(7, String::from("Old label"))],
            |left, right| left == right,
        );
        let id = state.entries[0].descriptor.id.clone();
        reconcile_devices(
            &mut state,
            vec![(7, String::from("New label"))],
            |left, right| left == right,
        );
        assert_eq!(state.entries[0].descriptor.id, id);
        assert_eq!(state.entries[0].descriptor.label, "New label");
        assert!(state.entries[0].descriptor.available);
    }

    #[test]
    fn observed_disappearance_permanently_retires_original_id() {
        let mut state = RegistryState::default();
        reconcile_devices(
            &mut state,
            vec![(9, String::from("Travel Mic"))],
            |left, right| left == right,
        );
        let id = state.entries[0].descriptor.id.clone();
        reconcile_devices(&mut state, vec![], |left, right| left == right);
        assert!(!state.entries[0].descriptor.available);

        reconcile_devices(
            &mut state,
            vec![(9, String::from("Travel Mic"))],
            |left, right| left == right,
        );
        let listed = descriptors(&state);
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, id);
        assert!(!listed[0].available);
        assert_ne!(listed[1].id, id);
        assert!(listed[1].available);
    }

    #[test]
    fn changed_native_identity_gets_new_id_without_replacing_stale_one() {
        let mut state = RegistryState::default();
        reconcile_devices(
            &mut state,
            vec![(9, String::from("Travel Mic"))],
            |left, right| left == right,
        );
        let original_id = state.entries[0].descriptor.id.clone();
        reconcile_devices(&mut state, vec![], |left, right| left == right);

        reconcile_devices(
            &mut state,
            vec![(10, String::from("Travel Mic"))],
            |left, right| left == right,
        );
        let listed = descriptors(&state);
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, original_id);
        assert!(!listed[0].available);
        assert!(listed[1].available);
        assert_ne!(listed[1].id, original_id);
    }

    #[test]
    fn missing_and_unknown_ids_fail_without_substitution() {
        let mut state = RegistryState::default();
        reconcile_devices(
            &mut state,
            vec![(11, String::from("Desk Mic"))],
            |left, right| left == right,
        );
        let id = state.entries[0].descriptor.id.clone();
        reconcile_devices(&mut state, vec![], |left, right| left == right);

        assert!(resolve_registered(&state, &id)
            .unwrap_err()
            .contains("disconnected"));
        assert!(resolve_registered(&state, "input-404")
            .unwrap_err()
            .contains("unknown microphone id"));
    }

    #[test]
    fn tombstones_are_bounded_and_ids_are_never_reused() {
        let mut state = RegistryState::default();
        let cycles = MAX_DEVICE_TOMBSTONES + 10;
        let mut issued = Vec::new();

        for native_id in 0..cycles {
            reconcile_devices(
                &mut state,
                vec![(native_id, format!("Mic {native_id}"))],
                |left, right| left == right,
            );
            issued.push(state.entries.last().unwrap().descriptor.id.clone());
            reconcile_devices(&mut state, vec![], |left, right| left == right);
        }

        assert_eq!(state.entries.len(), MAX_DEVICE_TOMBSTONES);
        let unique: std::collections::HashSet<_> = issued.iter().collect();
        assert_eq!(unique.len(), cycles);
        assert_eq!(state.next_id, cycles as u64 + 1);
        assert!(state.entries.iter().all(|entry| entry.device.is_none()));
    }

    #[test]
    fn enumeration_and_reconciliation_are_serialized() {
        use std::sync::mpsc;
        use std::thread;

        let registry = Arc::new(Mutex::new(RegistryState::default()));
        let (first_started_tx, first_started_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();
        let first_registry = Arc::clone(&registry);
        let first = thread::spawn(move || {
            refresh_registry(
                &first_registry,
                || {
                    first_started_tx.send(()).unwrap();
                    release_first_rx.recv().unwrap();
                    Ok(vec![(1, String::from("Older snapshot"))])
                },
                |left, right| left == right,
                |_| Ok(()),
            )
            .unwrap();
        });

        first_started_rx.recv().unwrap();
        let (second_attempt_tx, second_attempt_rx) = mpsc::channel();
        let (second_started_tx, second_started_rx) = mpsc::channel();
        let second_registry = Arc::clone(&registry);
        let second = thread::spawn(move || {
            second_attempt_tx.send(()).unwrap();
            refresh_registry(
                &second_registry,
                || {
                    second_started_tx.send(()).unwrap();
                    Ok(vec![(2, String::from("Newer snapshot"))])
                },
                |left, right| left == right,
                |_| Ok(()),
            )
            .unwrap();
        });

        second_attempt_rx.recv().unwrap();
        assert!(second_started_rx
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err());
        release_first_tx.send(()).unwrap();
        first.join().unwrap();
        second.join().unwrap();

        let state = registry.lock().unwrap();
        let available: Vec<_> = descriptors(&state)
            .into_iter()
            .filter(|device| device.available)
            .collect();
        assert_eq!(available.len(), 1);
        assert_eq!(available[0].label, "Newer snapshot");
    }

    // DeviceSelection debug

    #[test]
    fn device_selection_debug_shows_name() {
        let d = DeviceSelection::Id(String::from("input-3"));
        assert!(format!("{d:?}").contains("input-3"));
        let d2 = DeviceSelection::SystemDefault;
        assert!(format!("{d2:?}").contains("SystemDefault"));
    }

    // with_stream() requires live CoreAudio — manual test only.
}

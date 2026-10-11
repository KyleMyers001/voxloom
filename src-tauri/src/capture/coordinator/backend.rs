use super::*;

// Injectable seams

/// Permission backend seam.
pub trait PermissionBackend: Send + Sync + 'static {
    fn query(&self) -> MicPermission;
    fn request(&self, callback: Box<dyn FnOnce(bool) + Send>);
}

/// Stream metadata provided to the capture loop by `StreamBackend`.
/// Mirrors `stream::StreamMeta` for the real backend; tests supply
/// their own ring consumer + flags.
pub struct CaptureStreamMeta {
    /// True while the callback may accept new frames.
    pub accepting: Arc<CaptureGate>,
    /// Number of callbacks currently writing accepted frames.
    pub callbacks_in_flight: Arc<AtomicUsize>,
    pub device_name: String,
    pub native_rate: u32,
    pub consumer: ringbuf::HeapCons<f32>,
    /// Latched true on ring-buffer overflow → `input-limit-exceeded`.
    pub overflow: Arc<AtomicBool>,
    /// Latched true on device error → `capture-unavailable`.
    pub stream_error: Arc<AtomicBool>,
}

/// Stream backend seam.
/// `with_stream` calls `f` while the stream is alive, then drops the stream.
/// The stream need not be `Send`; it lives and dies in the scope of `f`.
pub trait StreamBackend: Send + Sync + 'static {
    fn with_stream<F, R>(&self, selection: &DeviceSelection, f: F) -> Result<R, String>
    where
        F: FnOnce(CaptureStreamMeta) -> R;

    #[allow(dead_code)]
    fn list_devices(&self) -> Result<Vec<InputDeviceDescriptor>, String>;
}

// Production backends

pub struct RealPermissionBackend;

impl PermissionBackend for RealPermissionBackend {
    fn query(&self) -> MicPermission {
        permission::query()
    }
    fn request(&self, callback: Box<dyn FnOnce(bool) + Send>) {
        let cb = Mutex::new(Some(callback));
        permission::request(move |granted| {
            if let Some(f) = cb.lock().unwrap().take() {
                f(granted);
            }
        });
    }
}

pub struct CpalStreamBackend {
    registry: DeviceRegistry,
}

impl CpalStreamBackend {
    pub(super) fn new() -> Self {
        Self {
            registry: DeviceRegistry::new(),
        }
    }
}

impl StreamBackend for CpalStreamBackend {
    fn with_stream<F, R>(&self, selection: &DeviceSelection, f: F) -> Result<R, String>
    where
        F: FnOnce(CaptureStreamMeta) -> R,
    {
        let device = match selection {
            DeviceSelection::SystemDefault => stream::default_input_device()?,
            DeviceSelection::Id(id) => self.registry.resolve(id)?,
        };
        stream::with_stream(device, |meta: StreamMeta| {
            f(CaptureStreamMeta {
                accepting: meta.accepting,
                callbacks_in_flight: meta.callbacks_in_flight,
                consumer: meta.consumer,
                device_name: meta.device_name,
                native_rate: meta.native_rate,
                overflow: meta.overflow,
                stream_error: meta.stream_error,
            })
        })
    }

    fn list_devices(&self) -> Result<Vec<InputDeviceDescriptor>, String> {
        self.registry.list()
    }
}

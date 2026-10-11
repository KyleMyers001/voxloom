use super::super::*;

pub(crate) struct FakeStreamBackend {
    pub(crate) native_rate: u32,
    pub(crate) samples: Vec<f32>,
    pub(crate) open_error: Option<String>,
    pub(crate) resource_alive: Option<Arc<AtomicBool>>,
    /// Pre-latch ring overflow flag (→ input-limit-exceeded).
    pub(crate) simulate_overflow: bool,
    /// Pre-latch stream_error flag (→ capture-unavailable).
    pub(crate) simulate_stream_error: bool,
}

impl FakeStreamBackend {
    pub(crate) fn new(samples: Vec<f32>) -> Self {
        FakeStreamBackend {
            native_rate: TARGET_RATE,
            open_error: None,
            resource_alive: None,
            samples,
            simulate_overflow: false,
            simulate_stream_error: false,
        }
    }
}

impl StreamBackend for FakeStreamBackend {
    fn with_stream<F, R>(&self, _selection: &DeviceSelection, f: F) -> Result<R, String>
    where
        F: FnOnce(CaptureStreamMeta) -> R,
    {
        if let Some(ref e) = self.open_error {
            return Err(e.clone());
        }
        use ringbuf::traits::{Producer, Split};
        let rb = ringbuf::HeapRb::<f32>::new(RING_CAPACITY);
        let (mut prod, cons) = rb.split();
        for &s in &self.samples {
            let _ = prod.try_push(s);
        }
        drop(prod);
        let meta = CaptureStreamMeta {
            accepting: shared_open_gate(),
            callbacks_in_flight: Arc::new(AtomicUsize::new(0)),
            consumer: cons,
            device_name: String::from("Fake"),
            native_rate: self.native_rate,
            overflow: Arc::new(AtomicBool::new(self.simulate_overflow)),
            stream_error: Arc::new(AtomicBool::new(self.simulate_stream_error)),
        };
        if let Some(alive) = &self.resource_alive {
            alive.store(true, Ordering::Release);
        }
        let output = f(meta);
        if let Some(alive) = &self.resource_alive {
            alive.store(false, Ordering::Release);
        }
        Ok(output)
    }

    fn list_devices(&self) -> Result<Vec<InputDeviceDescriptor>, String> {
        Ok(vec![])
    }
}

pub(crate) struct PostCaptureIdentityFailureBackend {
    pub(crate) resource_alive: Arc<AtomicBool>,
}

impl StreamBackend for PostCaptureIdentityFailureBackend {
    fn with_stream<F, R>(&self, _selection: &DeviceSelection, f: F) -> Result<R, String>
    where
        F: FnOnce(CaptureStreamMeta) -> R,
    {
        use ringbuf::traits::{Producer, Split};

        let ring = ringbuf::HeapRb::<f32>::new(RING_CAPACITY);
        let (mut producer, consumer) = ring.split();
        assert_eq!(producer.push_slice(&[0.5; 480]), 480);
        drop(producer);
        self.resource_alive.store(true, Ordering::Release);
        let output = f(CaptureStreamMeta {
            accepting: shared_open_gate(),
            callbacks_in_flight: Arc::new(AtomicUsize::new(0)),
            consumer,
            device_name: String::from("Identity Fake"),
            native_rate: TARGET_RATE,
            overflow: Arc::new(AtomicBool::new(false)),
            stream_error: Arc::new(AtomicBool::new(false)),
        });
        self.resource_alive.store(false, Ordering::Release);
        drop(output);
        Err(String::from(
            "capture-unavailable: microphone identity changed",
        ))
    }

    fn list_devices(&self) -> Result<Vec<InputDeviceDescriptor>, String> {
        Ok(vec![])
    }
}

pub(crate) struct RestartStreamBackend {
    pub(crate) opens: AtomicUsize,
    pub(crate) resource_alive: Arc<AtomicBool>,
}

impl StreamBackend for RestartStreamBackend {
    fn with_stream<F, R>(&self, _selection: &DeviceSelection, f: F) -> Result<R, String>
    where
        F: FnOnce(CaptureStreamMeta) -> R,
    {
        use ringbuf::traits::Split;

        let stream_error = self.opens.fetch_add(1, Ordering::AcqRel) == 0;
        let rb = ringbuf::HeapRb::<f32>::new(RING_CAPACITY);
        let (_producer, consumer) = rb.split();
        self.resource_alive.store(true, Ordering::Release);
        let output = f(CaptureStreamMeta {
            accepting: shared_open_gate(),
            callbacks_in_flight: Arc::new(AtomicUsize::new(0)),
            consumer,
            device_name: String::from("Restart Fake"),
            native_rate: 16_000,
            overflow: Arc::new(AtomicBool::new(false)),
            stream_error: Arc::new(AtomicBool::new(stream_error)),
        });
        self.resource_alive.store(false, Ordering::Release);
        Ok(output)
    }

    fn list_devices(&self) -> Result<Vec<InputDeviceDescriptor>, String> {
        Ok(vec![])
    }
}

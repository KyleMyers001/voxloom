use super::super::*;

pub(crate) struct ContinuousStreamBackend {
    pub(crate) resource_alive: Arc<AtomicBool>,
    pub(crate) runtime: ProductionVirtualRuntime,
}

impl StreamBackend for ContinuousStreamBackend {
    fn with_stream<F, R>(&self, _selection: &DeviceSelection, f: F) -> Result<R, String>
    where
        F: FnOnce(CaptureStreamMeta) -> R,
    {
        use ringbuf::traits::{Producer, Split};

        let ring = ringbuf::HeapRb::<f32>::new(RING_CAPACITY);
        let (mut producer, consumer) = ring.split();
        self.runtime.install_feed(move || {
            let _ = producer.try_push(0.25);
        });
        self.resource_alive.store(true, Ordering::Release);
        let output = f(CaptureStreamMeta {
            accepting: shared_open_gate(),
            callbacks_in_flight: Arc::new(AtomicUsize::new(0)),
            consumer,
            device_name: String::from("Continuous Fake"),
            native_rate: TARGET_RATE,
            overflow: Arc::new(AtomicBool::new(false)),
            stream_error: Arc::new(AtomicBool::new(false)),
        });
        self.runtime.clear_feed();
        self.resource_alive.store(false, Ordering::Release);
        Ok(output)
    }

    fn list_devices(&self) -> Result<Vec<InputDeviceDescriptor>, String> {
        Ok(vec![])
    }
}

pub(crate) struct ChangingDefaultBackend {
    pub(crate) opens: AtomicUsize,
}

impl StreamBackend for ChangingDefaultBackend {
    fn with_stream<F, R>(&self, selection: &DeviceSelection, f: F) -> Result<R, String>
    where
        F: FnOnce(CaptureStreamMeta) -> R,
    {
        use ringbuf::traits::Split;

        assert!(matches!(selection, DeviceSelection::SystemDefault));
        let index = self.opens.fetch_add(1, Ordering::AcqRel);
        let ring = ringbuf::HeapRb::<f32>::new(RING_CAPACITY);
        let (_producer, consumer) = ring.split();
        Ok(f(CaptureStreamMeta {
            accepting: shared_open_gate(),
            callbacks_in_flight: Arc::new(AtomicUsize::new(0)),
            consumer,
            device_name: format!("Default {index}"),
            native_rate: TARGET_RATE,
            overflow: Arc::new(AtomicBool::new(false)),
            stream_error: Arc::new(AtomicBool::new(true)),
        }))
    }

    fn list_devices(&self) -> Result<Vec<InputDeviceDescriptor>, String> {
        Ok(vec![])
    }
}

pub(crate) struct ListingBackend {
    pub(crate) error: Option<String>,
    pub(crate) listed: Vec<InputDeviceDescriptor>,
}

impl StreamBackend for ListingBackend {
    fn with_stream<F, R>(&self, _selection: &DeviceSelection, _f: F) -> Result<R, String>
    where
        F: FnOnce(CaptureStreamMeta) -> R,
    {
        panic!("device listing must not open an input stream")
    }

    fn list_devices(&self) -> Result<Vec<InputDeviceDescriptor>, String> {
        if let Some(error) = &self.error {
            Err(error.clone())
        } else {
            Ok(self.listed.clone())
        }
    }
}

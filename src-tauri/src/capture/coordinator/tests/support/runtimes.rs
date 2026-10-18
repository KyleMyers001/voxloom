use super::super::*;

pub(crate) fn open_gate() -> CaptureGate {
    let gate = CaptureGate::closed();
    assert!(gate.try_open());
    gate
}

pub(crate) fn shared_open_gate() -> Arc<CaptureGate> {
    Arc::new(open_gate())
}

// Fake backends

#[derive(Clone, Copy)]
pub(crate) struct FakePermission(pub(crate) MicPermission);

impl PermissionBackend for FakePermission {
    fn query(&self) -> MicPermission {
        self.0
    }
    fn request(&self, callback: Box<dyn FnOnce(bool) + Send>) {
        callback(self.0 == MicPermission::Authorized);
    }
}

pub(crate) struct CountingPermission {
    pub(crate) queries: Arc<AtomicUsize>,
    pub(crate) requests: Arc<AtomicUsize>,
}

impl PermissionBackend for CountingPermission {
    fn query(&self) -> MicPermission {
        self.queries.fetch_add(1, Ordering::AcqRel);
        MicPermission::Authorized
    }

    fn request(&self, callback: Box<dyn FnOnce(bool) + Send>) {
        self.requests.fetch_add(1, Ordering::AcqRel);
        callback(true);
    }
}

#[derive(Default)]
pub(crate) struct VirtualRuntime {
    pub(crate) elapsed_millis: AtomicU64,
}

impl LoopRuntime for VirtualRuntime {
    fn now(&self) -> Duration {
        Duration::from_millis(self.elapsed_millis.load(Ordering::Acquire))
    }

    fn wait(&self, duration: Duration) {
        let millis = duration.as_millis().max(1) as u64;
        self.elapsed_millis.fetch_add(millis, Ordering::AcqRel);
    }
}

#[derive(Clone, Default)]
pub(crate) struct ProductionVirtualRuntime {
    pub(crate) state: Arc<ProductionVirtualState>,
}

#[derive(Default)]
pub(crate) struct ProductionVirtualState {
    pub(crate) elapsed_millis: AtomicU64,
    pub(crate) feed: Mutex<Option<Box<dyn FnMut() + Send>>>,
    pub(crate) ten_second_observer: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl ProductionVirtualRuntime {
    pub(crate) fn clear_feed(&self) {
        self.state.feed.lock().unwrap().take();
    }

    pub(crate) fn elapsed(&self) -> Duration {
        Duration::from_millis(self.state.elapsed_millis.load(Ordering::Acquire))
    }

    pub(crate) fn install_feed(&self, feed: impl FnMut() + Send + 'static) {
        *self.state.feed.lock().unwrap() = Some(Box::new(feed));
    }

    pub(crate) fn observe_ten_seconds(&self, observer: impl FnOnce() + Send + 'static) {
        *self.state.ten_second_observer.lock().unwrap() = Some(Box::new(observer));
    }
}

impl LoopRuntime for ProductionVirtualRuntime {
    fn now(&self) -> Duration {
        self.elapsed()
    }

    fn wait(&self, duration: Duration) {
        let millis = duration.as_millis().max(1) as u64;
        let previous = self
            .state
            .elapsed_millis
            .fetch_add(millis, Ordering::AcqRel);
        if let Some(feed) = self.state.feed.lock().unwrap().as_mut() {
            feed();
        }
        if previous < 10_000 && previous + millis >= 10_000 {
            let observer = self.state.ten_second_observer.lock().unwrap().take();
            if let Some(observer) = observer {
                observer();
            }
        }
    }
}

pub(crate) struct DrainingRuntime {
    pub(crate) callbacks_in_flight: Arc<AtomicUsize>,
    pub(crate) waits: AtomicUsize,
}

impl LoopRuntime for DrainingRuntime {
    fn now(&self) -> Duration {
        Duration::from_millis(30)
    }

    fn wait(&self, _duration: Duration) {
        self.waits.fetch_add(1, Ordering::AcqRel);
        self.callbacks_in_flight.store(0, Ordering::SeqCst);
    }
}

pub(crate) fn short_test_limits() -> CaptureLimits {
    CaptureLimits {
        full_bound: Duration::from_millis(300),
        poll_interval: Duration::from_millis(10),
        test_bound: Duration::from_millis(30),
        watchdog_grace: Duration::from_secs(1),
        watchdog_idle: Duration::from_secs(1),
    }
}

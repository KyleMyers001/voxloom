use super::*;

#[derive(Clone, Copy)]
pub(super) struct CaptureLimits {
    pub(super) full_bound: Duration,
    pub(super) poll_interval: Duration,
    pub(super) test_bound: Duration,
    pub(super) watchdog_grace: Duration,
    pub(super) watchdog_idle: Duration,
}

impl CaptureLimits {
    pub(super) fn production() -> Self {
        CaptureLimits {
            full_bound: Duration::from_secs(FULL_SAFETY_SECS),
            poll_interval: Duration::from_millis(10),
            test_bound: Duration::from_secs(TEST_SAFETY_SECS),
            watchdog_grace: Duration::from_secs(1),
            watchdog_idle: Duration::from_secs(WATCHDOG_IDLE_SECS),
        }
    }
}

pub(super) trait LoopRuntime: Send + Sync + 'static {
    fn now(&self) -> Duration;
    fn wait(&self, duration: Duration);
}

pub(super) struct SystemLoopRuntime {
    epoch: Instant,
}

impl SystemLoopRuntime {
    pub(super) fn new() -> Self {
        SystemLoopRuntime {
            epoch: Instant::now(),
        }
    }
}

impl LoopRuntime for SystemLoopRuntime {
    fn now(&self) -> Duration {
        self.epoch.elapsed()
    }

    fn wait(&self, duration: Duration) {
        thread::sleep(duration);
    }
}

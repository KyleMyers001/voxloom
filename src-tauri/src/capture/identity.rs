//! Capture acceptance and native device-identity monitoring.

use std::sync::atomic::{AtomicU8, Ordering};

const INVALIDATED: u8 = 0b10;
const OPEN: u8 = 0b01;

/// Single-atomic capture gate. Invalidation is sticky and cannot be reopened.
pub struct CaptureGate(AtomicU8);

impl CaptureGate {
    pub fn closed() -> Self {
        Self(AtomicU8::new(0))
    }

    pub fn close(&self) {
        self.0.fetch_and(!OPEN, Ordering::SeqCst);
    }

    pub fn invalidate(&self) {
        // Replaces either CLOSED or OPEN. In SeqCst order, a later open CAS
        // cannot match zero, and an earlier successful CAS is closed here.
        self.0.store(INVALIDATED, Ordering::SeqCst);
    }

    pub fn is_invalidated(&self) -> bool {
        self.0.load(Ordering::SeqCst) & INVALIDATED != 0
    }

    pub fn is_open(&self) -> bool {
        self.0.load(Ordering::SeqCst) == OPEN
    }

    pub fn try_open(&self) -> bool {
        // Opening is legal only from pristine CLOSED. INVALIDATED is sticky.
        self.0
            .compare_exchange(0, OPEN, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
}

pub(super) fn require_valid(gate: &CaptureGate) -> Result<(), String> {
    if gate.is_invalidated() {
        Err(String::from(
            "capture-unavailable: microphone identity changed",
        ))
    } else {
        Ok(())
    }
}

mod listeners;
use listeners::{ListenerOperations, ListenerOwner};

#[cfg(target_os = "macos")]
mod admission;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
mod macos_api;

#[cfg(target_os = "macos")]
pub use macos::NativeIdentityMonitor;

pub fn validate_device_id(device_id: &cpal::DeviceId) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos_api::core_audio_uid(device_id).map(|_| ())
    }
    #[cfg(not(target_os = "macos"))]
    {
        if device_id.1.is_empty() {
            Err(String::from(
                "capture-unavailable: invalid microphone identity",
            ))
        } else {
            Ok(())
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub struct NativeIdentityMonitor {
    gate: std::sync::Arc<CaptureGate>,
}

#[cfg(not(target_os = "macos"))]
impl NativeIdentityMonitor {
    pub fn install(
        _device_id: &cpal::DeviceId,
        gate: std::sync::Arc<CaptureGate>,
    ) -> Result<Self, String> {
        Ok(Self { gate })
    }

    pub fn synchronize(&self) {}

    pub fn finish(self) -> Result<(), String> {
        require_valid(&self.gate)
    }

    pub fn validate(&self, device: &cpal::Device, expected: &cpal::DeviceId) -> Result<(), String> {
        use cpal::traits::DeviceTrait;
        if device.id().as_ref() == Ok(expected) {
            Ok(())
        } else {
            self.gate.invalidate();
            Err(String::from(
                "capture-unavailable: microphone identity changed",
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};

    #[test]
    fn invalidation_before_enable_cannot_reopen_gate() {
        let gate = CaptureGate::closed();
        gate.invalidate();
        assert!(!gate.try_open());
        assert!(!gate.is_open());
        assert!(gate.is_invalidated());
    }

    #[test]
    fn invalidation_closes_open_gate_and_remains_sticky() {
        let gate = CaptureGate::closed();
        assert!(gate.try_open());
        gate.invalidate();
        gate.close();
        assert!(!gate.try_open());
        assert!(gate.is_invalidated());
    }

    #[test]
    fn invalidation_is_fatal_at_every_stream_phase() {
        for phase in 0..6 {
            let gate = CaptureGate::closed();
            if phase <= 2 {
                gate.invalidate();
                assert!(!gate.try_open());
            } else {
                assert!(gate.try_open());
                gate.invalidate();
            }
            gate.close();
            assert!(require_valid(&gate).is_err(), "phase {phase}");
        }
    }

    struct FakeListeners {
        events: Arc<Mutex<Vec<String>>>,
        fail_registration: Option<u8>,
        fail_removal: Option<u8>,
        quarantined: Arc<AtomicBool>,
        removal_failures: usize,
    }

    impl ListenerOperations for FakeListeners {
        type Registration = u8;
        type Target = u8;

        fn register(&mut self, target: u8) -> Result<u8, String> {
            self.events
                .lock()
                .unwrap()
                .push(format!("register:{target}"));
            if self.fail_registration == Some(target) {
                Err(String::from("registration failed"))
            } else {
                Ok(target)
            }
        }

        fn remove(&mut self, registration: &u8) -> Result<(), String> {
            self.events
                .lock()
                .unwrap()
                .push(format!("remove:{registration}"));
            if self.fail_removal == Some(*registration) && self.removal_failures > 0 {
                self.removal_failures -= 1;
                Err(String::from("removal failed"))
            } else {
                Ok(())
            }
        }

        fn synchronize(&self) {
            self.events
                .lock()
                .unwrap()
                .push(String::from("synchronize"));
        }

        fn quarantine(&mut self) {
            self.quarantined.store(true, Ordering::SeqCst);
        }
    }

    fn fake_listeners(events: Arc<Mutex<Vec<String>>>) -> FakeListeners {
        FakeListeners {
            events,
            fail_registration: None,
            fail_removal: None,
            quarantined: Arc::new(AtomicBool::new(false)),
            removal_failures: 0,
        }
    }

    #[test]
    fn partial_registration_cleans_up_registered_callbacks() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut listeners = fake_listeners(Arc::clone(&events));
        listeners.fail_registration = Some(2);
        let mut owner = ListenerOwner::new(listeners);
        owner.register(1).unwrap();
        assert!(owner.register(2).is_err());
        drop(owner);

        assert_eq!(
            *events.lock().unwrap(),
            ["register:1", "register:2", "remove:1", "synchronize"],
        );
    }

    #[test]
    fn listener_cleanup_is_reverse_order_and_synchronized() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut owner = ListenerOwner::new(fake_listeners(Arc::clone(&events)));
        owner.register(1).unwrap();
        owner.register(2).unwrap();
        owner.finish().unwrap();

        assert_eq!(
            *events.lock().unwrap(),
            [
                "register:1",
                "register:2",
                "remove:2",
                "remove:1",
                "synchronize",
            ],
        );
    }

    #[test]
    fn removal_failure_retries_exact_registration() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut listeners = fake_listeners(Arc::clone(&events));
        listeners.fail_removal = Some(2);
        listeners.removal_failures = 1;
        let mut owner = ListenerOwner::new(listeners);
        owner.register(1).unwrap();
        owner.register(2).unwrap();

        owner.finish().unwrap();
        assert_eq!(
            *events.lock().unwrap(),
            [
                "register:1",
                "register:2",
                "remove:2",
                "remove:1",
                "synchronize",
                "remove:2",
                "synchronize",
            ],
        );
    }

    #[test]
    fn permanent_removal_failure_quarantines_after_retry() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let quarantined = Arc::new(AtomicBool::new(false));
        let mut listeners = fake_listeners(Arc::clone(&events));
        listeners.fail_removal = Some(1);
        listeners.quarantined = Arc::clone(&quarantined);
        listeners.removal_failures = 2;
        let mut owner = ListenerOwner::new(listeners);
        owner.register(1).unwrap();

        assert_eq!(owner.finish().unwrap_err(), "removal failed");
        assert!(quarantined.load(Ordering::SeqCst));
        assert_eq!(
            *events.lock().unwrap(),
            [
                "register:1",
                "remove:1",
                "synchronize",
                "remove:1",
                "synchronize",
            ],
        );
    }

    struct LifetimeRegistration {
        events: Arc<Mutex<Vec<String>>>,
        id: u8,
    }

    impl Drop for LifetimeRegistration {
        fn drop(&mut self) {
            self.events
                .lock()
                .unwrap()
                .push(format!("drop:{}", self.id));
        }
    }

    struct LifetimeListeners {
        events: Arc<Mutex<Vec<String>>>,
        fail_removal: bool,
    }

    impl ListenerOperations for LifetimeListeners {
        type Registration = LifetimeRegistration;
        type Target = u8;

        fn register(&mut self, target: u8) -> Result<Self::Registration, String> {
            Ok(LifetimeRegistration {
                events: Arc::clone(&self.events),
                id: target,
            })
        }

        fn remove(&mut self, registration: &Self::Registration) -> Result<(), String> {
            self.events
                .lock()
                .unwrap()
                .push(format!("remove:{}", registration.id));
            if self.fail_removal {
                Err(String::from("removal failed"))
            } else {
                Ok(())
            }
        }

        fn synchronize(&self) {
            self.events
                .lock()
                .unwrap()
                .push(String::from("synchronize"));
        }
    }

    #[test]
    fn listener_blocks_live_until_removal_queue_is_synchronized() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut owner = ListenerOwner::new(LifetimeListeners {
            events: Arc::clone(&events),
            fail_removal: false,
        });
        owner.register(1).unwrap();
        owner.finish().unwrap();

        assert_eq!(
            *events.lock().unwrap(),
            ["remove:1", "synchronize", "drop:1"],
        );
    }

    #[test]
    fn permanently_registered_block_is_retained_after_cleanup_failure() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut owner = ListenerOwner::new(LifetimeListeners {
            events: Arc::clone(&events),
            fail_removal: true,
        });
        owner.register(1).unwrap();
        assert!(owner.finish().is_err());

        let events = events.lock().unwrap();
        assert_eq!(
            events.as_slice(),
            ["remove:1", "synchronize", "remove:1", "synchronize"],
        );
        assert!(!events.iter().any(|event| event == "drop:1"));
    }
}

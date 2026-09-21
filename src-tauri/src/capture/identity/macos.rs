use std::ptr::NonNull;
use std::sync::Arc;

use block2::RcBlock;
use cpal::DeviceId;
use dispatch2::{DispatchQueue, DispatchRetained};
use objc2_core_audio::{
    kAudioDevicePropertyDeviceIsAlive, kAudioDevicePropertyDeviceUID,
    kAudioHardwarePropertyDevices,
    kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal,
    kAudioObjectSystemObject, AudioObjectAddPropertyListenerBlock,
    AudioObjectID, AudioObjectPropertyAddress,
    AudioObjectRemovePropertyListenerBlock,
};

use super::admission;
use super::{require_valid, CaptureGate, ListenerOperations, ListenerOwner};
use super::macos_api::{
    check_status, core_audio_uid, device_is_alive, translate_uid,
};

type ListenerBlock = RcBlock<dyn Fn(u32, NonNull<AudioObjectPropertyAddress>)>;

struct Registration {
    address: AudioObjectPropertyAddress,
    block: ListenerBlock,
    object_id: AudioObjectID,
}

#[derive(Clone, Copy)]
struct ListenerTarget {
    object_id: AudioObjectID,
    selector: u32,
}

struct NativeListenerOperations {
    gate: Arc<CaptureGate>,
    queue: DispatchRetained<DispatchQueue>,
}

impl ListenerOperations for NativeListenerOperations {
    type Registration = Registration;
    type Target = ListenerTarget;

    fn register(
        &mut self,
        target: ListenerTarget,
    ) -> Result<Registration, String> {
        let address = AudioObjectPropertyAddress {
            mElement: kAudioObjectPropertyElementMain,
            mScope: kAudioObjectPropertyScopeGlobal,
            mSelector: target.selector,
        };
        let gate = Arc::clone(&self.gate);
        let block: ListenerBlock = RcBlock::new(move |_, _| {
            gate.invalidate();
        });
        let status = unsafe {
            AudioObjectAddPropertyListenerBlock(
                target.object_id,
                NonNull::from(&address),
                Some(&self.queue),
                RcBlock::as_ptr(&block),
            )
        };
        check_status(status, "register identity listener")?;
        Ok(Registration {
            address,
            block,
            object_id: target.object_id,
        })
    }

    fn remove(&mut self, registration: &Registration) -> Result<(), String> {
        let status = unsafe {
            AudioObjectRemovePropertyListenerBlock(
                registration.object_id,
                NonNull::from(&registration.address),
                Some(&self.queue),
                RcBlock::as_ptr(&registration.block),
            )
        };
        check_status(status, "remove identity listener")
    }

    fn synchronize(&self) {
        // Called only by the capture worker, never from this queue.
        self.queue.exec_sync(|| {});
    }

    fn quarantine(&mut self) {
        admission::quarantine();
    }
}

pub struct NativeIdentityMonitor {
    device_id: AudioObjectID,
    gate: Arc<CaptureGate>,
    listeners: Option<ListenerOwner<NativeListenerOperations>>,
}

impl NativeIdentityMonitor {
    pub fn install(
        expected: &DeviceId,
        gate: Arc<CaptureGate>,
    ) -> Result<Self, String> {
        let expected_uid = core_audio_uid(expected)?;
        admission::reserve()?;
        let queue = DispatchQueue::new("com.voxloom.capture.identity", None);
        let operations = NativeListenerOperations {
            gate: Arc::clone(&gate),
            queue,
        };
        let mut monitor = Self {
            device_id: 0,
            gate,
            listeners: Some(ListenerOwner::new(operations)),
        };

        monitor.register(ListenerTarget {
            object_id: kAudioObjectSystemObject as AudioObjectID,
            selector: kAudioHardwarePropertyDevices,
        })?;
        monitor.device_id = translate_uid(expected_uid)?;
        monitor.register(ListenerTarget {
            object_id: monitor.device_id,
            selector: kAudioDevicePropertyDeviceIsAlive,
        })?;
        monitor.register(ListenerTarget {
            object_id: monitor.device_id,
            selector: kAudioDevicePropertyDeviceUID,
        })?;
        Ok(monitor)
    }

    pub fn synchronize(&self) {
        if let Some(listeners) = &self.listeners {
            listeners.synchronize();
        }
    }

    pub fn finish(mut self) -> Result<(), String> {
        let cleanup = self.cleanup();
        self.release_admission();
        cleanup?;
        require_valid(&self.gate)
    }

    pub fn validate(
        &self,
        device: &cpal::Device,
        expected: &DeviceId,
    ) -> Result<(), String> {
        use cpal::traits::DeviceTrait;

        let valid = !self.gate.is_invalidated()
            && device.id().as_ref() == Ok(expected)
            && translate_uid(&expected.1).ok() == Some(self.device_id)
            && device_is_alive(self.device_id).unwrap_or(false);
        if valid {
            Ok(())
        } else {
            self.gate.invalidate();
            Err(String::from(
                "capture-unavailable: microphone identity changed",
            ))
        }
    }

    fn register(&mut self, target: ListenerTarget) -> Result<(), String> {
        self.listeners
            .as_mut()
            .expect("listeners exist until finish")
            .register(target)
    }

    fn cleanup(&mut self) -> Result<(), String> {
        self.listeners
            .take()
            .map_or(Ok(()), ListenerOwner::finish)
    }

    fn release_admission(&self) {
        admission::release();
    }
}

impl Drop for NativeIdentityMonitor {
    fn drop(&mut self) {
        let _ = self.cleanup();
        self.release_admission();
    }
}

//! Narrow CoreAudio identity and availability queries.

use std::ffi::c_void;
use std::mem::size_of;
use std::ptr::{null, NonNull};

use cpal::platform::HostId;
use cpal::DeviceId;
use objc2_core_audio::{
    kAudioDevicePropertyDeviceIsAlive,
    kAudioHardwarePropertyTranslateUIDToDevice,
    kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal,
    kAudioObjectSystemObject, AudioObjectGetPropertyData, AudioObjectID,
    AudioObjectPropertyAddress,
};
use objc2_core_foundation::CFString;

pub(super) fn check_status(
    status: i32,
    operation: &str,
) -> Result<(), String> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!(
            "capture-unavailable: {operation} failed ({status})",
        ))
    }
}

pub(super) fn core_audio_uid(expected: &DeviceId) -> Result<&str, String> {
    if expected.0 != HostId::CoreAudio || expected.1.is_empty() {
        Err(String::from(
            "capture-unavailable: invalid CoreAudio microphone UID",
        ))
    } else {
        Ok(&expected.1)
    }
}

pub(super) fn device_is_alive(
    device_id: AudioObjectID,
) -> Result<bool, String> {
    let address = AudioObjectPropertyAddress {
        mElement: kAudioObjectPropertyElementMain,
        mScope: kAudioObjectPropertyScopeGlobal,
        mSelector: kAudioDevicePropertyDeviceIsAlive,
    };
    let mut alive = 0u32;
    let mut size = size_of::<u32>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            device_id,
            NonNull::from(&address),
            0,
            null(),
            NonNull::from(&mut size),
            NonNull::from(&mut alive).cast::<c_void>(),
        )
    };
    check_status(status, "query microphone availability")?;
    Ok(alive != 0)
}

pub(super) fn translate_uid(uid: &str) -> Result<AudioObjectID, String> {
    let address = AudioObjectPropertyAddress {
        mElement: kAudioObjectPropertyElementMain,
        mScope: kAudioObjectPropertyScopeGlobal,
        mSelector: kAudioHardwarePropertyTranslateUIDToDevice,
    };
    let uid = CFString::from_str(uid);
    let uid_ref: *const CFString = &*uid;
    let mut device_id = 0u32;
    let mut size = size_of::<AudioObjectID>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            kAudioObjectSystemObject as AudioObjectID,
            NonNull::from(&address),
            size_of::<*const CFString>() as u32,
            (&uid_ref as *const *const CFString).cast::<c_void>(),
            NonNull::from(&mut size),
            NonNull::from(&mut device_id).cast::<c_void>(),
        )
    };
    check_status(status, "resolve microphone UID")?;
    if device_id == 0 {
        Err(String::from(
            "capture-unavailable: microphone UID is unavailable",
        ))
    } else {
        Ok(device_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_audio_uid_rejects_empty_identity() {
        let identity = DeviceId(HostId::CoreAudio, String::new());
        assert!(core_audio_uid(&identity).is_err());
    }

    #[test]
    fn core_audio_uid_accepts_nonempty_core_audio_identity() {
        let identity = DeviceId(
            HostId::CoreAudio,
            String::from("persistent-device-uid"),
        );
        assert_eq!(core_audio_uid(&identity).unwrap(), identity.1);
    }
}

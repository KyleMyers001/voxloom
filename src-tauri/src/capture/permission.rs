/// macOS AVFoundation microphone permission bridge.
///
/// Wraps AVCaptureDevice class methods to query and request microphone
/// access. Never resets TCC or modifies system permission state.
///
/// The non-macOS stub returns `Denied` so the coordinator fails closed on
/// unsupported platforms.
#[cfg(target_os = "macos")]
mod macos {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{
        AVAuthorizationStatus, AVCaptureDevice, AVMediaType,
    };

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum MicPermission {
        NotDetermined,
        Authorized,
        Denied,
    }

    /// Query the current microphone authorization status without prompting.
    ///
    /// Safe to call from any thread after the Objective-C runtime is
    /// initialized (which Tauri does on application start).
    pub fn query() -> MicPermission {
        // SAFETY: `authorizationStatusForMediaType:` is safe to call from
        // any thread and does not trigger a permission prompt.
        let status = unsafe {
            AVCaptureDevice::authorizationStatusForMediaType(
                audio_media_type(),
            )
        };
        map_status(status)
    }

    /// Request microphone access, invoking `callback` on an arbitrary
    /// GCD queue with the granted result.
    ///
    /// Only prompts the user when status is `NotDetermined`. When Denied
    /// or Restricted the callback fires immediately with `false`.
    pub fn request<F>(callback: F)
    where
        F: Fn(bool) + Send + 'static,
    {
        let block = RcBlock::new(move |granted: Bool| {
            callback(granted.as_bool());
        });
        // SAFETY: `requestAccessForMediaType:completionHandler:` may be
        // called from any thread. RcBlock derefs to DynBlock (Block<F>).
        unsafe {
            AVCaptureDevice::requestAccessForMediaType_completionHandler(
                audio_media_type(),
                &*block,
            );
        }
    }

    fn map_status(status: AVAuthorizationStatus) -> MicPermission {
        match status {
            AVAuthorizationStatus::NotDetermined => {
                MicPermission::NotDetermined
            }
            AVAuthorizationStatus::Authorized => MicPermission::Authorized,
            _ => MicPermission::Denied,
        }
    }

    /// Reference to the AVMediaTypeAudio constant.
    ///
    /// SAFETY: constant is always present on macOS 10.7+ and is never null.
    unsafe fn audio_media_type() -> &'static AVMediaType {
        objc2_av_foundation::AVMediaTypeAudio
            .expect("AVMediaTypeAudio missing")
    }
}

#[cfg(not(target_os = "macos"))]
mod stub {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum MicPermission {
        NotDetermined,
        Authorized,
        Denied,
    }

    /// Non-macOS: native capture is unavailable; fail closed.
    pub fn query() -> MicPermission {
        MicPermission::Denied
    }

    /// Non-macOS: no-op; coordinator surfaces `capture-unavailable`.
    pub fn request<F>(_callback: F)
    where
        F: Fn(bool) + Send + 'static,
    {
    }
}

#[cfg(target_os = "macos")]
pub use macos::{query, request, MicPermission};

#[cfg(not(target_os = "macos"))]
pub use stub::{query, request, MicPermission};

#[cfg(test)]
mod tests {
    use super::MicPermission;

    #[test]
    fn permission_variants_are_distinct() {
        assert_ne!(MicPermission::NotDetermined, MicPermission::Authorized);
        assert_ne!(MicPermission::Authorized, MicPermission::Denied);
        assert_ne!(MicPermission::NotDetermined, MicPermission::Denied);
    }

    #[test]
    fn permission_is_copy() {
        let p = MicPermission::Authorized;
        let q = p;
        assert_eq!(p, q);
    }
    // query() and request() require a foreground TCC context.
    // Manual test coverage documented in docs/review/BUS-9-implementation.md.
}

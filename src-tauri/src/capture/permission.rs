/// macOS AVFoundation microphone permission bridge.
///
/// Wraps `AVCaptureDevice` class methods to query and request microphone
/// access. Exposes all four AVAuthorizationStatus values:
/// NotDetermined, Authorized, Denied, Restricted.
///
/// The same API is used in `tauri-dev` and in a packaged `Voxloom.app`.
/// TCC client *identity* comes from the process bundle (Info.plist +
/// codesign), not from a separate request path — hence the packaged-app
/// bundle work in BUS-10. Never resets TCC or modifies system permission
/// state; deny/revoke remain System Settings only.
/// The non-macOS stub returns `Denied` so the coordinator fails closed.
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
        Restricted,
    }

    /// Query the current microphone authorization status without prompting.
    pub fn query() -> MicPermission {
        // SAFETY: class method call, no run loop required.
        let status = unsafe {
            AVCaptureDevice::authorizationStatusForMediaType(
                audio_media_type(),
            )
        };
        map_status(status)
    }

    /// Request microphone access, invoking `callback` on a GCD queue.
    /// Prompts only when status is `NotDetermined`.
    pub fn request<F>(callback: F)
    where
        F: Fn(bool) + Send + 'static,
    {
        let block = RcBlock::new(move |granted: Bool| {
            callback(granted.as_bool());
        });
        // SAFETY: RcBlock derefs to Block/DynBlock.
        unsafe {
            AVCaptureDevice::requestAccessForMediaType_completionHandler(
                audio_media_type(),
                &*block,
            );
        }
    }

    fn map_status(s: AVAuthorizationStatus) -> MicPermission {
        match s {
            AVAuthorizationStatus::NotDetermined => {
                MicPermission::NotDetermined
            }
            AVAuthorizationStatus::Authorized => MicPermission::Authorized,
            AVAuthorizationStatus::Restricted => MicPermission::Restricted,
            _ => MicPermission::Denied,
        }
    }

    /// Reference to the AVMediaTypeAudio constant.
    /// SAFETY: always present on macOS 10.7+.
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
        Restricted,
    }

    pub fn query() -> MicPermission {
        // Non-macOS: native capture unavailable, fail closed.
        MicPermission::Denied
    }

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
    fn all_four_variants_are_distinct() {
        let variants = [
            MicPermission::NotDetermined,
            MicPermission::Authorized,
            MicPermission::Denied,
            MicPermission::Restricted,
        ];
        for (i, a) in variants.iter().enumerate() {
            for (j, b) in variants.iter().enumerate() {
                if i != j {
                    assert_ne!(a, b);
                }
            }
        }
    }

    #[test]
    fn mic_permission_is_copy() {
        let p = MicPermission::Authorized;
        let q = p;
        assert_eq!(p, q);
    }
    // query() and request() require a foreground TCC context.
    // Manual tests documented in docs/review/BUS-9-implementation.md.
}

use super::*;

// Session events

/// Events emitted to the renderer. No PCM bytes included. Session and
/// permission events carry correlation fields.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SessionEvent {
    PermissionStatus {
        generation: u64,
        request_id: String,
        status: PermissionStatus,
    },
    CaptureStarted {
        device_name: String,
        generation: u64,
        request_id: String,
    },
    ActivityDetected {
        generation: u64,
        request_id: String,
    },
    CaptureLevel {
        generation: u64,
        request_id: String,
        level: f32,
    },
    TestComplete {
        generation: u64,
        metadata: TestCaptureMetadata,
        request_id: String,
    },
    CaptureStopped {
        generation: u64,
        request_id: String,
        /// Opaque local PCM handle for STT (BUS-10). Absent when empty.
        #[serde(skip_serializing_if = "Option::is_none")]
        audio: Option<crate::capture::pcm_store::AudioBufferHandleDto>,
    },
    CaptureCancelled {
        generation: u64,
        request_id: String,
    },
    CaptureError {
        category: String,
        generation: u64,
        message: String,
        request_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureMode {
    Full,
    Test,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CaptureStatus {
    pub generation: u64,
    pub mode: CaptureMode,
    pub request_id: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionStatus {
    NotDetermined,
    Authorized,
    Denied,
    Restricted,
}

impl From<MicPermission> for PermissionStatus {
    fn from(p: MicPermission) -> Self {
        match p {
            MicPermission::NotDetermined => PermissionStatus::NotDetermined,
            MicPermission::Authorized => PermissionStatus::Authorized,
            MicPermission::Denied => PermissionStatus::Denied,
            MicPermission::Restricted => PermissionStatus::Restricted,
        }
    }
}

//! Guided setup permission boundary. Query never prompts; OS calls are injected in tests.
use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionKind {
    Microphone,
    Accessibility,
    InputMonitoring,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionState {
    Authorized,
    NotDetermined,
    Denied,
    Restricted,
    NotGranted,
    /// Only the non-Mac adapter reports this.
    #[cfg(not(target_os = "macos"))]
    Unsupported,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    microphone: PermissionState,
    accessibility: PermissionState,
    input_monitoring: PermissionState,
}

trait PermissionBackend {
    fn query(&self, kind: PermissionKind) -> PermissionState;
    fn request(&self, kind: PermissionKind) -> Result<(), String>;
}
fn from_preflight(allowed: bool) -> PermissionState {
    if allowed {
        PermissionState::Authorized
    } else {
        PermissionState::NotGranted
    }
}
fn query_all(backend: &impl PermissionBackend) -> Permissions {
    Permissions {
        microphone: backend.query(PermissionKind::Microphone),
        accessibility: backend.query(PermissionKind::Accessibility),
        input_monitoring: backend.query(PermissionKind::InputMonitoring),
    }
}
fn request_one(
    backend: &impl PermissionBackend,
    kind: PermissionKind,
) -> Result<PermissionState, String> {
    if backend.query(kind) != PermissionState::Authorized {
        backend.request(kind)?;
    }
    Ok(backend.query(kind))
}
fn settings_url(kind: PermissionKind) -> &'static str {
    match kind {
        PermissionKind::Microphone => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        }
        PermissionKind::Accessibility => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
        PermissionKind::InputMonitoring => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
        }
    }
}
/// AX has no not-requested/denied distinction to query. The first request in this
/// launch asks macOS to prompt: that lists Voxloom in Privacy & Security ›
/// Accessibility (a fresh install may be missing from it) and the alert offers its
/// own Open System Settings button, so the pane is not opened as a second, competing
/// handoff. macOS may not repeat the alert, so later requests open the pane.
fn request_accessibility(
    prompted: &AtomicBool,
    prompt: impl FnOnce() -> bool,
    open_pane: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if !prompted.swap(true, Ordering::SeqCst) && prompt() {
        return Ok(());
    }
    open_pane()
}
struct System;
#[cfg(target_os = "macos")]
static AX_PROMPTED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
#[repr(C)]
struct CFDictionaryCallBacks {
    _opaque: [u8; 0],
}
#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
    // Apple AXUIElement.h (macOS 10.9+): returns current trust without waiting;
    // with the prompt option macOS shows its alert asynchronously when untrusted.
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> u8;
    static kAXTrustedCheckOptionPrompt: *const c_void;
    fn CGPreflightListenEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;
}
#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFDictionaryCreate(
        allocator: *const c_void,
        keys: *const *const c_void,
        values: *const *const c_void,
        count: isize,
        key_callbacks: *const CFDictionaryCallBacks,
        value_callbacks: *const CFDictionaryCallBacks,
    ) -> *const c_void;
    fn CFRelease(cf: *const c_void);
    static kCFBooleanTrue: *const c_void;
    static kCFTypeDictionaryKeyCallBacks: CFDictionaryCallBacks;
    static kCFTypeDictionaryValueCallBacks: CFDictionaryCallBacks;
}
/// False when the options could not be built, so the caller falls back to Settings.
#[cfg(target_os = "macos")]
fn prompt_accessibility() -> bool {
    // SAFETY: framework constants; the one-entry dictionary is released after use.
    unsafe {
        let keys = [kAXTrustedCheckOptionPrompt];
        let values = [kCFBooleanTrue];
        let options = CFDictionaryCreate(
            std::ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            1,
            std::ptr::addr_of!(kCFTypeDictionaryKeyCallBacks),
            std::ptr::addr_of!(kCFTypeDictionaryValueCallBacks),
        );
        if options.is_null() {
            return false;
        }
        AXIsProcessTrustedWithOptions(options);
        CFRelease(options);
        true
    }
}
impl PermissionBackend for System {
    fn query(&self, kind: PermissionKind) -> PermissionState {
        #[cfg(target_os = "macos")]
        {
            use crate::capture::permission::{self, MicPermission};
            match kind {
                PermissionKind::Microphone => match permission::query() {
                    MicPermission::Authorized => PermissionState::Authorized,
                    MicPermission::NotDetermined => PermissionState::NotDetermined,
                    MicPermission::Denied => PermissionState::Denied,
                    MicPermission::Restricted => PermissionState::Restricted,
                },
                PermissionKind::Accessibility => {
                    from_preflight(unsafe { AXIsProcessTrusted() } != 0)
                }
                PermissionKind::InputMonitoring => {
                    from_preflight(unsafe { CGPreflightListenEventAccess() })
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = kind;
            PermissionState::Unsupported
        }
    }
    fn request(&self, kind: PermissionKind) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        match kind {
            PermissionKind::Microphone => {
                if self.query(kind) == PermissionState::NotDetermined {
                    let (send, recv) = std::sync::mpsc::channel();
                    crate::capture::permission::request(move |_| {
                        let _ = send.send(());
                    });
                    recv.recv_timeout(std::time::Duration::from_secs(120))
                        .map_err(|_| {
                            "Microphone request has not settled. Check again.".to_owned()
                        })?;
                    Ok(())
                } else {
                    open_settings(kind)
                }
            }
            PermissionKind::Accessibility => {
                request_accessibility(&AX_PROMPTED, prompt_accessibility, || open_settings(kind))
            }
            PermissionKind::InputMonitoring => {
                unsafe {
                    CGRequestListenEventAccess();
                }
                Ok(())
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = kind;
            Err("Guided setup permissions require macOS".into())
        }
    }
}
fn open_settings(kind: PermissionKind) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("/usr/bin/open")
            .arg(settings_url(kind))
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("Could not open System Settings. Open Privacy & Security manually.".into())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = kind;
        Err("System Settings requires macOS".into())
    }
}
#[tauri::command]
pub fn setup_query_permissions() -> Permissions {
    query_all(&System)
}
#[tauri::command]
pub async fn setup_request_permission(kind: PermissionKind) -> Result<PermissionState, String> {
    tauri::async_runtime::spawn_blocking(move || request_one(&System, kind))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn setup_open_permission_settings(kind: PermissionKind) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_settings(kind))
        .await
        .map_err(|e| e.to_string())?
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelReadiness {
    model_id: String,
    ready: bool,
    status: &'static str,
    reason: Option<String>,
}
#[tauri::command]
pub async fn setup_model_readiness(
    state: tauri::State<'_, crate::stt::SttState>,
    model_id: String,
) -> Result<ModelReadiness, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let engine = if crate::stt::catalog::find(&model_id).is_some() {
            cfg!(all(target_os = "macos", feature = "whisper"))
        } else {
            crate::stt::parakeet_catalog::find(&model_id).is_some()
                && crate::stt::parakeet_catalog::is_supported()
                && crate::stt::parakeet::worker_path::installed().is_file()
        };
        let verified = engine && state.models.setup_verified(&model_id);
        let info = state.models.status(&model_id);
        let status = if !engine {
            "unavailable"
        } else if info.as_ref().is_some_and(|info| info.status == "downloading") {
            "downloading"
        } else if verified {
            "available"
        } else if info.as_ref().is_some_and(|info| info.status == "available") {
            "pending"
        } else {
            "missing"
        };
        let ready = status == "available";
        ModelReadiness { model_id, ready, status, reason: if ready { None } else if !engine {
            Some("The selected speech engine is unavailable in this build or on this Mac.".into())
        } else if status == "pending" {
            Some("The selected voice pack is still being verified. Check again when verification finishes.".into())
        } else { Some("The selected voice pack is missing, downloading or not verified. Check or retry the download.".into()) } }
    }).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Fake(RefCell<Vec<PermissionKind>>);
    impl PermissionBackend for Fake {
        fn query(&self, kind: PermissionKind) -> PermissionState {
            match kind {
                PermissionKind::Microphone => PermissionState::Denied,
                _ => from_preflight(false),
            }
        }
        fn request(&self, kind: PermissionKind) -> Result<(), String> {
            self.0.borrow_mut().push(kind);
            Ok(())
        }
    }
    #[test]
    fn setup_readiness_rejects_unverified_corrupt_file_even_when_list_says_available() {
        let root = std::env::temp_dir().join(format!("voxloom-bus208-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let store = crate::stt::store::ModelStore::new(root.clone());
        let spec = crate::stt::catalog::find("whisper-base.en").unwrap();
        std::fs::write(root.join(spec.filename), b"not weights").unwrap();
        assert_eq!(store.status(spec.id).unwrap().status, "available");
        assert!(!store.setup_verified(spec.id));
        assert_eq!(store.status(spec.id).unwrap().status, "failed");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn query_never_prompts_and_boolean_preflight_is_not_denied() {
        let fake = Fake(RefCell::new(vec![]));
        let states = query_all(&fake);
        assert_eq!(states.microphone, PermissionState::Denied);
        assert_eq!(states.accessibility, PermissionState::NotGranted);
        assert_eq!(states.input_monitoring, PermissionState::NotGranted);
        assert!(fake.0.borrow().is_empty());
        assert_eq!(from_preflight(true), PermissionState::Authorized);
    }
    #[test]
    fn explicit_request_only_requests_the_named_permission_then_requeries() {
        let fake = Fake(RefCell::new(vec![]));
        assert_eq!(
            request_one(&fake, PermissionKind::InputMonitoring).unwrap(),
            PermissionState::NotGranted
        );
        assert_eq!(*fake.0.borrow(), vec![PermissionKind::InputMonitoring]);
        assert_eq!(
            settings_url(PermissionKind::Microphone),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        );
        assert!(settings_url(PermissionKind::Accessibility).ends_with("Privacy_Accessibility"));
        assert!(settings_url(PermissionKind::InputMonitoring).ends_with("Privacy_ListenEvent"));
    }
    #[test]
    fn accessibility_prompts_once_per_launch_then_opens_settings() {
        let prompted = AtomicBool::new(false);
        let calls = RefCell::new(vec![]);
        let prompt = || {
            calls.borrow_mut().push("prompt");
            true
        };
        let pane = || {
            calls.borrow_mut().push("settings");
            Ok(())
        };
        // The system alert carries its own Settings button: no second handoff.
        request_accessibility(&prompted, prompt, pane).unwrap();
        assert_eq!(*calls.borrow(), vec!["prompt"]);
        // macOS may not repeat the alert, so a later Allow must still do something.
        request_accessibility(&prompted, prompt, pane).unwrap();
        assert_eq!(*calls.borrow(), vec!["prompt", "settings"]);
    }
    #[test]
    fn accessibility_falls_back_to_settings_when_the_prompt_cannot_be_asked() {
        let prompted = AtomicBool::new(false);
        let opened = RefCell::new(0);
        let pane = || {
            *opened.borrow_mut() += 1;
            Err("Could not open System Settings.".to_owned())
        };
        assert!(request_accessibility(&prompted, || false, pane).is_err());
        assert_eq!(*opened.borrow(), 1);
    }
    #[test]
    fn already_trusted_accessibility_is_never_requested() {
        struct Trusted(RefCell<Vec<PermissionKind>>);
        impl PermissionBackend for Trusted {
            fn query(&self, _: PermissionKind) -> PermissionState {
                PermissionState::Authorized
            }
            fn request(&self, kind: PermissionKind) -> Result<(), String> {
                self.0.borrow_mut().push(kind);
                Ok(())
            }
        }
        let trusted = Trusted(RefCell::new(vec![]));
        assert_eq!(
            request_one(&trusted, PermissionKind::Accessibility).unwrap(),
            PermissionState::Authorized
        );
        assert!(trusted.0.borrow().is_empty());
    }
}

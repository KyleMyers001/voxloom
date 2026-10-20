//! `cleanup_prewarm` (BUS-16 3c-2c C2): load and warm the cleanup model
//! ahead of the first dictation, so the cold load doesn't come out of its
//! 10 s budget. The renderer calls it when the switch is turned on, and a
//! little after launch when cleanup is already on; at launch only, macOS
//! Low Power Mode skips it (battery alone doesn't). It runs in the
//! background: the command returns once the worker has started.

use std::sync::Arc;

use tauri::{Runtime, State, Webview};

use super::auth::require_main;
use super::model_store::{ModelLease, MODEL_ID};
use super::supervisor::{LowPowerMode, WorkerSupervisor};
use super::{CleanupCommandError, CleanupState};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Trigger {
    Launch,
    SwitchOn,
}

impl Trigger {
    fn parse(value: &str) -> Result<Self, CleanupCommandError> {
        match value {
            "launch" => Ok(Self::Launch),
            "switch-on" => Ok(Self::SwitchOn),
            _ => Err(CleanupCommandError::runtime("unknown prewarm trigger")),
        }
    }
}

#[tauri::command]
pub async fn cleanup_prewarm<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, CleanupState>,
    trigger: String,
) -> Result<&'static str, CleanupCommandError> {
    require_main(&webview)?;
    let trigger = Trigger::parse(&trigger)?;
    let models = Arc::clone(&state.models);
    let supervisor = Arc::clone(&state.supervisor);
    tauri::async_runtime::spawn_blocking(move || {
        prewarm(&supervisor, trigger, low_power_mode, || {
            models.lease(MODEL_ID)
        })
    })
    .await
    .map_err(|error| CleanupCommandError::runtime(format!("cleanup prewarm task failed: {error}")))
}

/// What happened: "started", or why it was skipped. The renderer ignores it.
pub(super) fn prewarm(
    supervisor: &WorkerSupervisor,
    trigger: Trigger,
    low_power_mode: LowPowerMode,
    lease: impl FnOnce() -> Result<ModelLease, String>,
) -> &'static str {
    if trigger == Trigger::Launch && low_power_mode() {
        return "low-power";
    }
    if !supervisor.available() {
        return "unavailable";
    }
    // Before the hash, so a dictation arriving meanwhile is never refused.
    let Some(ticket) = supervisor.reserve_prewarm() else {
        return "busy";
    };
    let Ok(mut lease) = lease() else {
        return "unavailable";
    };
    // As for a run: the worker only ever loads a verified descriptor.
    if lease.verify().is_err() {
        return "unavailable";
    }
    if ticket.start(lease, low_power_mode) {
        "started"
    } else {
        "busy"
    }
}

/// macOS Low Power Mode, read when the launch prewarm is due. Not checked
/// on the box: CI's macOS jobs only compile it.
#[cfg(target_os = "macos")]
fn low_power_mode() -> bool {
    objc2_foundation::NSProcessInfo::processInfo().isLowPowerModeEnabled()
}

/// Other platforms have no such mode the app reads: never skip.
#[cfg(not(target_os = "macos"))]
fn low_power_mode() -> bool {
    false
}

#[cfg(all(test, unix))]
#[path = "prewarm_tests.rs"]
mod tests;

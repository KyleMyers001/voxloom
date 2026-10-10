//! BUS-14 insertion delivery — platform adapter boundary.
//! macOS: Accessibility (AX) snapshot + insert. Other OS: honest stubs.
//! Never synthesizes Enter / Tab / command chords as product submit.
//! macOS inserts via verified AXSelectedText; web fields that ignore it fall back
//! to Unicode key events (no clipboard, no command chords). Failures use the TS
//! Copy policy.

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod decide;
mod types;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(not(target_os = "macos"))]
mod stub;

pub use types::TargetSnapshotDto;

#[cfg(target_os = "macos")]
use macos as platform;

#[cfg(not(target_os = "macos"))]
use stub as platform;

/// Snapshot frontmost app + focused AX element insertability (invocation).
#[tauri::command]
pub fn delivery_snapshot_target() -> Result<TargetSnapshotDto, String> {
    platform::snapshot_target()
}

/// Re-validate intended target at completion time.
/// Async: runs off the main thread so AX calls never stall the UI.
#[tauri::command(async)]
pub fn delivery_validate_target(intended: TargetSnapshotDto) -> Result<TargetSnapshotDto, String> {
    platform::validate_target(intended)
}

/// Insert plain text into the intended target; refuse wrong/secure targets.
/// Async: typing + read-back polling must not block the main/UI thread.
#[tauri::command(async)]
pub fn delivery_insert_text(
    text: String,
    intended: TargetSnapshotDto,
) -> Result<decide::InsertReport, String> {
    platform::insert_text(&text, &intended)
}

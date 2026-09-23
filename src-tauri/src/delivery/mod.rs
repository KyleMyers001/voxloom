//! BUS-14 insertion delivery — platform adapter boundary.
//! macOS: Accessibility (AX) snapshot + insert. Other OS: honest stubs.
//! Never synthesizes Enter / Tab / command chords as product submit.
//! Paste without trailing Enter is allowed only as AX setValue fallback.

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
#[tauri::command]
pub fn delivery_validate_target(
    intended: TargetSnapshotDto,
) -> Result<TargetSnapshotDto, String> {
    platform::validate_target(intended)
}

/// Insert plain text into the intended target; refuse wrong/secure targets.
#[tauri::command]
pub fn delivery_insert_text(
    text: String,
    intended: TargetSnapshotDto,
) -> Result<(), String> {
    platform::insert_text(&text, &intended)
}

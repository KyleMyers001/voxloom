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

/// Snapshot frontmost app + focused AX element after transcription completes.
/// Async: for Chromium/Electron it re-asserts web accessibility and may wait
/// (bounded, ~2.4 s) for the real field, which must never block the UI thread.
#[tauri::command(async)]
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
///
/// Contract relied on by the frontend (`tauriAdapter.insertText`): an `Err`
/// means nothing was written. Every error path returns before the first AX
/// write or key event, or after a read-back proves the field is unchanged.
/// Once anything may have landed (a partial typing run, a changed but
/// unconfirmed AX value) the command returns `Ok` with `unverified: true`,
/// never `Err`. So the UI may only say "maybe inserted" for `Ok(unverified)`.
#[tauri::command(async)]
pub fn delivery_insert_text(
    text: String,
    intended: TargetSnapshotDto,
) -> Result<decide::InsertReport, String> {
    platform::insert_text(&text, &intended)
}

#[cfg(test)]
mod insert_contract_tests {
    use super::decide::{after_ax, terminal, AfterAx};

    /// Native errors never come after a write (see `delivery_insert_text`).
    #[test]
    fn native_errors_never_follow_a_write() {
        // Terminal typing: an error before any chunk is Err; after one chunk it is Ok(unverified).
        let first = terminal::dispatch("hi", || Ok(()), |_| Err("posting denied".into()));
        assert!(first.is_err());
        let long = "a".repeat(64);
        let mut posted = 0;
        let partial = terminal::dispatch(
            &long,
            || Ok(()),
            |_| {
                posted += 1;
                if posted > 1 {
                    Err("lost focus".into())
                } else {
                    Ok(())
                }
            },
        )
        .expect("a partial write must not be Err");
        assert!(partial.unverified && partial.typed);
        // AX path: Failed (→ Err) only when the read-back shows the field unchanged.
        assert!(matches!(
            after_ax(false, Err("e".into()), "a", Some("a"), "b"),
            AfterAx::Failed(_)
        ));
        assert_eq!(
            after_ax(false, Err("e".into()), "a", Some("ab?"), "b"),
            AfterAx::Unverified
        );
        assert_eq!(
            after_ax(false, Err("e".into()), "a", None, "b"),
            AfterAx::Unverified
        );
    }
}

//! BUS-14 insertion delivery — platform adapter boundary.
//! macOS: Accessibility (AX) snapshot + insert. Other OS: honest stubs.
//! Never synthesizes Enter / Tab as product submit. Command chords: only the
//! terminal paste route's ⌘V.
//! macOS inserts via verified AXSelectedText; web fields that ignore it fall back
//! to Unicode key events (no clipboard, no command chords). Terminals without
//! an insertable AX field take a separate clipboard + ⌘V route (`paste`). Failures
//! use the TS Copy policy.

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod decide;
mod types;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(not(target_os = "macos"))]
mod stub;

pub use types::{PasteBindingDto, TargetSnapshotDto};

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

/// The paste terminal in front right now (pid + app path), taken when
/// dictation starts. None when the frontmost app is not a paste terminal.
/// Cheap: no AX reads, never activates anything.
#[tauri::command(async)]
pub fn delivery_paste_binding() -> Option<PasteBindingDto> {
    platform::paste_binding()
}

/// Paste into a terminal through the clipboard (⌘V), then restore the user's
/// clipboard. Same contract as `delivery_insert_text`: `Err` means nothing was
/// pasted; `Ok` means ⌘V was posted, which is not proof the terminal took it.
/// `bound` is the terminal that was in front when dictation started; the app in front must be it.
/// Async: the clipboard restore waits, which must not block the UI thread.
#[tauri::command(async)]
pub fn delivery_paste_text(
    text: String,
    bound: PasteBindingDto,
) -> Result<decide::report::PasteReport, String> {
    platform::paste_text(&text, &bound)
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

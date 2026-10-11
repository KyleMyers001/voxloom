//! Chromium/Electron web accessibility (AX side). Policy and tests live in
//! `decide::web_ax`: re-enable on every insert attempt (no per-pid cache) and
//! wait, bounded and synchronously, for the real focused field.

use super::ax::*;
use super::focus::focused_ui_element_once;
use super::host;
use crate::delivery::decide::web_ax::{
    bootstrap_allowed, needs_web_ax, reassert_with, wait_for_focus, Read, BOOTSTRAP_WAIT_MS,
};

type Focus = Result<(AXUIElementRef, Option<String>), String>;

/// Set the host's activation attribute on its application element.
/// Idempotent; only for allowlisted Chromium/Electron hosts. Returns whether
/// the attribute was set.
pub fn reassert(pid: Option<i32>) -> bool {
    let activation = pid.and_then(host::web_ax_activation);
    let trusted = unsafe { AXIsProcessTrusted() } != 0;
    reassert_with(pid, activation, trusted, |pid, activation| {
        let app = unsafe { AXUIElementCreateApplication(pid) };
        if app.is_null() {
            return false;
        }
        let ok = element_pid(app) == Some(pid) && set_web_accessibility(app, activation) == AX_OK;
        release(app as CFTypeRef);
        ok
    })
}

/// One focus read for the wait: a real field in `pid` (still frontmost).
fn read_once(stage: &str, pid: i32) -> Read<(AXUIElementRef, Option<String>), String> {
    if host::frontmost_pid() != Some(pid) || unsafe { AXIsProcessTrusted() } == 0 {
        return Read::Abort(
            "web focus wait aborted — foreground changed or permission denied".into(),
        );
    }
    let (el, name) = match focused_ui_element_once(stage) {
        Ok(found) => found,
        Err(e) => return Read::Retry(e),
    };
    if element_pid(el) != Some(pid) || host::frontmost_pid() != Some(pid) {
        release(el as CFTypeRef);
        return Read::Abort("web focus wait aborted — focused process changed".into());
    }
    if needs_web_ax(copy_string_attr(el, "AXRole").as_deref()) {
        release(el as CFTypeRef);
        return Read::Retry(
            "Accessibility web focus still unavailable after initialization".into(),
        );
    }
    Read::Found((el, name))
}

/// If `initial` is only a web container in an allowlisted, frontmost host,
/// wait (≤ ~2.4 s) for the real field in that same pid. Otherwise return
/// `initial` unchanged. A later-discovered field is accepted only while the
/// same pid stays frontmost (amendment: docs/decisions/web-ax-reenable.md).
pub fn settle_focus(stage: &str, front: Option<i32>, initial: Focus) -> Focus {
    let role = initial
        .as_ref()
        .ok()
        .and_then(|(el, _)| copy_string_attr(*el, "AXRole"));
    let focused_pid = initial
        .as_ref()
        .ok()
        .map(|(el, _)| element_pid(*el).unwrap_or(0));
    let known = front.and_then(host::web_ax_activation).is_some();
    let trusted = unsafe { AXIsProcessTrusted() } != 0;
    if !needs_web_ax(role.as_deref()) || !bootstrap_allowed(trusted, known, front, focused_pid) {
        return initial;
    }
    let pid = front.unwrap_or_default(); // bootstrap_allowed requires Some(pid > 0).
    let waited = wait_for_focus(
        || read_once(stage, pid),
        || std::thread::sleep(std::time::Duration::from_millis(BOOTSTRAP_WAIT_MS)),
    );
    match waited {
        Ok(found) => {
            if let Ok((el, _)) = initial {
                release(el as CFTypeRef);
            }
            Ok(found)
        }
        // Keep the original (non-insertable) observation for honest reasons.
        Err(_) => initial,
    }
}

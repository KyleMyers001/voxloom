//! Which frontmost apps are terminals, for the "Copied, press ⌘V" hint.
//!
//! Display only: this never authorizes a transport. Apple Terminal is matched
//! by its exact system path (as `terminal::apple_terminal_host` does); the
//! others by `.app` bundle name, as `host` matches browsers. A bundle name is
//! not an identity, so a mismatch costs a generic message, never an insert.

use super::host::app_bundle_root;
use super::terminal::apple_terminal_host;
use crate::delivery::types::TargetSnapshotDto;

/// Third-party terminal bundle names (lowercase, without `.app`).
/// iTerm2 ships as `iTerm.app`.
const TERMINAL_BUNDLES: &[&str] = &["iterm", "wezterm", "alacritty", "kitty", "ghostty"];

/// `exe_path` is the frontmost process's executable path.
pub fn is_known_terminal(exe_path: &str) -> bool {
    if apple_terminal_host(exe_path) {
        return true;
    }
    let Some(bundle) = app_bundle_root(exe_path) else {
        return false;
    };
    let name = bundle
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .trim_end_matches(".app")
        .to_lowercase();
    TERMINAL_BUNDLES.contains(&name.as_str())
}

/// Set the display flag on a snapshot. The pid is the focused element's app,
/// else the frontmost app (AX gave no focus, e.g. no AX text or no permission).
/// `is_terminal` resolves a pid to an executable and calls `is_known_terminal`.
pub fn flag_terminal(
    mut snap: TargetSnapshotDto,
    frontmost_pid: impl FnOnce() -> Option<i32>,
    is_terminal: impl FnOnce(Option<i32>) -> bool,
) -> TargetSnapshotDto {
    snap.known_terminal = is_terminal(snap.app_pid.or_else(frontmost_pid));
    snap
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::delivery::decide::test_support::target;

    #[test]
    fn flag_uses_the_focused_pid_else_the_frontmost_pid() {
        let seen = |snap, front: Option<i32>| {
            let mut asked = None;
            let out = flag_terminal(
                snap,
                || front,
                |pid| {
                    asked = Some(pid);
                    pid == Some(7)
                },
            );
            (asked.unwrap(), out.known_terminal)
        };
        // Focused app wins over the frontmost one.
        assert_eq!(
            seen(target("insertable", Some(7), None), Some(9)),
            (Some(7), true)
        );
        assert_eq!(
            seen(target("insertable", Some(9), None), Some(7)),
            (Some(9), false)
        );
        // No AX pid: fall back to the frontmost app.
        assert_eq!(
            seen(target("unavailable", None, None), Some(7)),
            (Some(7), true)
        );
        assert_eq!(
            seen(target("unavailable", None, None), Some(9)),
            (Some(9), false)
        );
        assert_eq!(seen(target("unavailable", None, None), None), (None, false));
    }

    #[test]
    fn flag_overwrites_a_stale_value() {
        let mut snap = target("unavailable", None, None);
        snap.known_terminal = true;
        assert!(!flag_terminal(snap, || None, |_| false).known_terminal);
    }

    #[test]
    fn apple_terminal_and_the_five_named_terminals_are_known() {
        for exe in [
            "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
            "/Applications/iTerm.app/Contents/MacOS/iTerm2",
            "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui",
            "/Applications/Alacritty.app/Contents/MacOS/alacritty",
            "/Applications/kitty.app/Contents/MacOS/kitty",
            "/Applications/Ghostty.app/Contents/MacOS/ghostty",
            "/opt/apps/Ghostty.app/Contents/MacOS/ghostty",
        ] {
            assert!(is_known_terminal(exe), "{exe}");
        }
    }

    #[test]
    fn other_apps_and_lookalikes_are_not_terminals() {
        for exe in [
            "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit",
            "/System/Applications/Notes.app/Contents/MacOS/Notes",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
            // Only the exact system path is Apple Terminal.
            "/Applications/Terminal.app/Contents/MacOS/Terminal",
            "/Applications/iTerm2-notes.app/Contents/MacOS/x",
            "/usr/bin/zsh",
            "/opt/homebrew/bin/kitty",
            "",
        ] {
            assert!(!is_known_terminal(exe), "{exe}");
        }
    }
}

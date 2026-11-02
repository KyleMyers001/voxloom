//! Which frontmost apps are terminals: for the "Copied. Press ⌘V to paste."
//! hint, and for the clipboard paste route (`paste`).
//!
//! Apple Terminal is matched by its exact system path (as
//! `terminal::apple_terminal_host` does); the others by `.app` bundle name, as
//! `host` matches browsers. A bundle name is not an identity: a lookalike app
//! costs a wrong hint, or a ⌘V into an app that shares a terminal's name.
//! Apple Terminal never takes the paste route (it has its own Unicode route).

use super::host::app_bundle_root;
use super::terminal::apple_terminal_host;
use crate::delivery::types::TargetSnapshotDto;

/// Terminals the paste route supports (lowercase bundle name without `.app`).
/// iTerm2 ships as `iTerm.app`.
const PASTE_BUNDLES: &[&str] = &["iterm", "wezterm", "alacritty", "kitty", "ghostty"];

/// Recognised for the hint only. Warp has its own input editor and the paste
/// route has not been tried there.
const HINT_ONLY_BUNDLES: &[&str] = &["warp"];

fn bundle_name(exe_path: &str) -> Option<String> {
    let bundle = app_bundle_root(exe_path)?;
    let name = bundle.rsplit('/').next().unwrap_or_default();
    Some(name.trim_end_matches(".app").to_lowercase())
}

/// `exe_path` is the frontmost process's executable path.
pub fn is_paste_terminal(exe_path: &str) -> bool {
    bundle_name(exe_path).is_some_and(|name| PASTE_BUNDLES.contains(&name.as_str()))
}

pub fn is_known_terminal(exe_path: &str) -> bool {
    apple_terminal_host(exe_path)
        || is_paste_terminal(exe_path)
        || bundle_name(exe_path).is_some_and(|name| HINT_ONLY_BUNDLES.contains(&name.as_str()))
}

/// App bundle path of a paste terminal (`/Applications/WezTerm.app`), else
/// None. With the pid it identifies the terminal a paste is bound to.
pub fn paste_app(exe_path: &str) -> Option<String> {
    if !is_paste_terminal(exe_path) {
        return None;
    }
    app_bundle_root(exe_path).map(str::to_string)
}

/// What the snapshot records about the frontmost terminal.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TerminalFlags {
    pub known: bool,
    pub paste: bool,
    /// Set iff `paste`.
    pub paste_app: Option<String>,
}

impl TerminalFlags {
    pub fn from_exe(exe_path: &str) -> Self {
        Self {
            known: is_known_terminal(exe_path),
            paste: is_paste_terminal(exe_path),
            paste_app: paste_app(exe_path),
        }
    }
}

/// Set the terminal flags on a snapshot. The pid is the focused element's app,
/// else the frontmost app (AX gave no focus, e.g. no AX text or no permission);
/// a snapshot without an app pid takes the frontmost one, so a later paste can
/// be bound to it. `flags_for` resolves a pid to an executable and calls
/// `TerminalFlags::from_exe`.
pub fn flag_terminal(
    mut snap: TargetSnapshotDto,
    frontmost_pid: impl FnOnce() -> Option<i32>,
    flags_for: impl FnOnce(Option<i32>) -> TerminalFlags,
) -> TargetSnapshotDto {
    let pid = snap.app_pid.or_else(frontmost_pid);
    let flags = flags_for(pid);
    snap.app_pid = pid;
    snap.known_terminal = flags.known;
    snap.paste_terminal = flags.paste;
    snap.paste_app = flags.paste_app;
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
                    TerminalFlags {
                        known: pid == Some(7),
                        paste: pid == Some(7),
                        paste_app: (pid == Some(7)).then(|| "/Applications/W.app".into()),
                    }
                },
            );
            assert_eq!(out.known_terminal, out.paste_terminal);
            assert_eq!(out.paste_terminal, out.paste_app.is_some());
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
    fn flag_records_the_frontmost_pid_when_the_snapshot_has_none() {
        let flags = |_: Option<i32>| TerminalFlags::default();
        let filled = flag_terminal(target("unavailable", None, None), || Some(5), flags);
        assert_eq!(filled.app_pid, Some(5));
        let kept = flag_terminal(target("insertable", Some(7), None), || Some(5), flags);
        assert_eq!(kept.app_pid, Some(7));
        let none = flag_terminal(target("unavailable", None, None), || None, flags);
        assert_eq!(none.app_pid, None);
    }

    #[test]
    fn paste_app_is_the_bundle_path_of_paste_terminals_only() {
        assert_eq!(
            paste_app("/Applications/WezTerm.app/Contents/MacOS/wezterm-gui").as_deref(),
            Some("/Applications/WezTerm.app")
        );
        assert_eq!(
            paste_app("/Applications/Warp.app/Contents/MacOS/stable"),
            None
        );
        assert_eq!(
            paste_app("/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"),
            None
        );
        assert_eq!(paste_app("/usr/bin/zsh"), None);
    }

    #[test]
    fn flag_overwrites_a_stale_value() {
        let mut snap = target("unavailable", None, None);
        snap.known_terminal = true;
        snap.paste_terminal = true;
        snap.paste_app = Some("/Applications/Stale.app".into());
        let out = flag_terminal(snap, || None, |_| TerminalFlags::default());
        assert!(!out.known_terminal && !out.paste_terminal && out.paste_app.is_none());
    }

    #[test]
    fn apple_terminal_and_the_named_terminals_are_known() {
        for exe in [
            "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
            "/Applications/iTerm.app/Contents/MacOS/iTerm2",
            "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui",
            "/Applications/Alacritty.app/Contents/MacOS/alacritty",
            "/Applications/kitty.app/Contents/MacOS/kitty",
            "/Applications/Ghostty.app/Contents/MacOS/ghostty",
            "/Applications/Warp.app/Contents/MacOS/stable",
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

    #[test]
    fn only_the_supported_terminals_take_the_paste_route() {
        for exe in [
            "/Applications/iTerm.app/Contents/MacOS/iTerm2",
            "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui",
            "/Applications/Alacritty.app/Contents/MacOS/alacritty",
            "/Applications/kitty.app/Contents/MacOS/kitty",
            "/Applications/Ghostty.app/Contents/MacOS/ghostty",
        ] {
            assert!(is_paste_terminal(exe), "{exe}");
            let flags = TerminalFlags::from_exe(exe);
            assert!(flags.known && flags.paste, "{exe}");
            let app = flags.paste_app.expect("paste terminals record their app");
            assert!(app.ends_with(".app") && exe.starts_with(&app), "{exe}");
        }
        // Known for the hint, but never pasted into.
        for exe in [
            "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
            "/Applications/Warp.app/Contents/MacOS/stable",
        ] {
            assert!(!is_paste_terminal(exe), "{exe}");
            assert_eq!(
                TerminalFlags::from_exe(exe),
                TerminalFlags {
                    known: true,
                    paste: false,
                    paste_app: None
                }
            );
        }
        for exe in [
            "/Applications/Notes.app/Contents/MacOS/Notes",
            "/usr/bin/zsh",
            "",
        ] {
            assert_eq!(
                TerminalFlags::from_exe(exe),
                TerminalFlags::default(),
                "{exe}"
            );
        }
    }
}

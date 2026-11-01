//! Which frontmost apps are terminals, for the "Copied, press ⌘V" hint.
//!
//! Display only: this never authorizes a transport. Apple Terminal is matched
//! by its exact system path (as `terminal::apple_terminal_host` does); the
//! others by `.app` bundle name, as `host` matches browsers. A bundle name is
//! not an identity, so a mismatch costs a generic message, never an insert.

use super::host::app_bundle_root;
use super::terminal::apple_terminal_host;

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

#[cfg(test)]
mod tests {
    use super::*;

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

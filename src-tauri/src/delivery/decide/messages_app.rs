//! Apple Messages (`com.apple.MobileSMS`) on the clipboard paste route.
//!
//! Its composer reads back no AXValue Voxloom can use, so AX insertion is
//! skipped (`AXValue unreadable`). It takes the same route as the paste
//! terminals: transcript on the clipboard, one ⌘V, clipboard restored. It is
//! matched by its exact system path, like Apple Terminal, so a lookalike app
//! named "Messages" elsewhere on disk is never pasted into.

const MESSAGES_EXE: &str = "/System/Applications/Messages.app/Contents/MacOS/Messages";

pub fn apple_messages_host(exe_path: &str) -> bool {
    exe_path == MESSAGES_EXE
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::delivery::decide::known_terminal::{
        is_known_terminal, is_paste_terminal, paste_app, TerminalFlags,
    };

    #[test]
    fn only_the_exact_system_messages_app_matches() {
        assert!(apple_messages_host(MESSAGES_EXE));
        for exe in [
            "/Applications/Messages.app/Contents/MacOS/Messages",
            "/System/Applications/Messages.app/Contents/MacOS/Other",
            "/System/Applications/Messages.app",
            "/usr/bin/Messages",
            "",
        ] {
            assert!(!apple_messages_host(exe), "{exe}");
            assert!(!is_paste_terminal(exe), "{exe}");
        }
    }

    #[test]
    fn messages_takes_the_paste_route_and_records_its_app_path() {
        assert!(is_paste_terminal(MESSAGES_EXE));
        assert!(is_known_terminal(MESSAGES_EXE));
        assert_eq!(
            paste_app(MESSAGES_EXE).as_deref(),
            Some("/System/Applications/Messages.app")
        );
        assert_eq!(
            TerminalFlags::from_exe(MESSAGES_EXE),
            TerminalFlags {
                known: true,
                paste: true,
                paste_app: Some("/System/Applications/Messages.app".into()),
            }
        );
    }

    #[test]
    fn other_apple_apps_and_the_existing_routes_are_unchanged() {
        for exe in [
            "/System/Applications/Notes.app/Contents/MacOS/Notes",
            "/System/Applications/Mail.app/Contents/MacOS/Mail",
            "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit",
        ] {
            assert_eq!(TerminalFlags::from_exe(exe), TerminalFlags::default());
        }
        // Apple Terminal keeps its own route; WezTerm still pastes.
        assert!(!is_paste_terminal(
            "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"
        ));
        assert!(is_paste_terminal(
            "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui"
        ));
    }
}

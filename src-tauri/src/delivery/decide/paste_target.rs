//! Binds a paste to the terminal (or Messages) that was in front when
//! dictation started.
//! The pid and app path are captured at recording start; the app in front at
//! delivery must be that same process and app, or nothing is pasted.

use crate::delivery::types::PasteBindingDto;

/// The binding for the frontmost process, from its pid and its paste-terminal
/// app path (None when it is not a paste terminal). None means dictation did
/// not start in a paste terminal, so nothing can be pasted later.
pub fn binding_for(front_pid: Option<i32>, front_app: Option<String>) -> Option<PasteBindingDto> {
    Some(PasteBindingDto {
        app_pid: front_pid?,
        paste_app: front_app?,
    })
}

/// `front_pid` / `front_app` are the frontmost process and its paste-terminal
/// app path now. Returns the pid to paste into. Anything missing or different
/// fails closed, so the caller copies instead.
pub fn check_paste_target(
    bound: &PasteBindingDto,
    front_pid: Option<i32>,
    front_app: Option<&str>,
) -> Result<i32, String> {
    match (front_pid, front_app) {
        (Some(pid), Some(app)) if pid == bound.app_pid && app == bound.paste_app => Ok(pid),
        _ => Err("frontmost app is not the app dictation started in — paste skipped".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WEZ: &str = "/Applications/WezTerm.app";

    fn bound() -> PasteBindingDto {
        PasteBindingDto {
            app_pid: 7,
            paste_app: WEZ.into(),
        }
    }

    #[test]
    fn the_same_terminal_pid_and_app_may_be_pasted_into() {
        assert_eq!(check_paste_target(&bound(), Some(7), Some(WEZ)), Ok(7));
    }

    #[test]
    fn another_app_or_terminal_in_front_is_refused() {
        // Not a paste terminal at all (Notes), another terminal, a second
        // instance of the same terminal, a reused pid under another app.
        for (pid, app) in [
            (Some(7), None),
            (Some(9), Some("/Applications/Ghostty.app")),
            (Some(8), Some(WEZ)),
            (Some(7), Some("/Applications/Ghostty.app")),
            (None, None),
            (None, Some(WEZ)),
        ] {
            assert!(
                check_paste_target(&bound(), pid, app).is_err(),
                "{pid:?} {app:?}"
            );
        }
    }

    #[test]
    fn messages_binds_and_refuses_a_terminal_in_its_place() {
        const MSG: &str = "/System/Applications/Messages.app";
        let bound = binding_for(Some(5), Some(MSG.into())).unwrap();
        assert_eq!(check_paste_target(&bound, Some(5), Some(MSG)), Ok(5));
        // WezTerm in front now (another pid and app), or not a paste app at all.
        assert!(check_paste_target(&bound, Some(7), Some(WEZ)).is_err());
        assert!(check_paste_target(&bound, Some(5), None).is_err());
    }

    #[test]
    fn a_binding_needs_both_a_pid_and_a_paste_terminal() {
        assert_eq!(binding_for(Some(7), Some(WEZ.into())), Some(bound()));
        // Dictation started in an app that is not a paste terminal.
        assert_eq!(binding_for(Some(7), None), None);
        assert_eq!(binding_for(None, Some(WEZ.into())), None);
        assert_eq!(binding_for(None, None), None);
    }
}

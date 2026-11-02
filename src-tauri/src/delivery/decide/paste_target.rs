//! Binds a paste to the terminal dictation started in. The snapshot taken at
//! recording start records the terminal's pid and app path; the app in front
//! at delivery must be that same process and app, or nothing is pasted.

use crate::delivery::types::TargetSnapshotDto;

/// `front_pid` / `front_app` are the frontmost process and its paste-terminal
/// app path (None when it is not a paste terminal). Returns the pid to paste
/// into. Anything missing fails closed, so the caller copies instead.
pub fn check_paste_target(
    intended: &TargetSnapshotDto,
    front_pid: Option<i32>,
    front_app: Option<&str>,
) -> Result<i32, String> {
    if intended.kind == "secure" {
        return Err("refusing paste into a secure field".into());
    }
    let (Some(want_pid), Some(want_app)) = (intended.app_pid, intended.paste_app.as_deref()) else {
        return Err("no terminal recorded when dictation started — paste skipped".into());
    };
    if !intended.paste_terminal {
        return Err("dictation did not start in a supported terminal — paste skipped".into());
    }
    match (front_pid, front_app) {
        (Some(pid), Some(app)) if pid == want_pid && app == want_app => Ok(pid),
        _ => Err("frontmost app is not the terminal dictation started in — paste skipped".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::delivery::decide::test_support::target;

    const WEZ: &str = "/Applications/WezTerm.app";

    fn terminal(pid: Option<i32>, app: Option<&str>) -> TargetSnapshotDto {
        let mut snap = target("unsupported", pid, None);
        snap.paste_terminal = true;
        snap.paste_app = app.map(str::to_string);
        snap
    }

    #[test]
    fn the_same_terminal_pid_and_app_may_be_pasted_into() {
        assert_eq!(
            check_paste_target(&terminal(Some(7), Some(WEZ)), Some(7), Some(WEZ)),
            Ok(7)
        );
    }

    #[test]
    fn another_app_or_terminal_in_front_is_refused() {
        let intended = terminal(Some(7), Some(WEZ));
        // Not a paste terminal at all (Notes), another terminal, a second
        // instance of the same terminal, a reused pid under another app.
        for (pid, app) in [
            (Some(7), None),
            (Some(9), Some("/Applications/Ghostty.app")),
            (Some(8), Some(WEZ)),
            (Some(7), Some("/Applications/Ghostty.app")),
            (None, None),
            (None, Some(WEZ)),
            (Some(7), None),
        ] {
            assert!(
                check_paste_target(&intended, pid, app).is_err(),
                "{pid:?} {app:?}"
            );
        }
    }

    #[test]
    fn a_snapshot_without_a_recorded_terminal_fails_closed() {
        for intended in [
            terminal(None, Some(WEZ)),
            terminal(Some(7), None),
            target("unavailable", Some(7), None),
        ] {
            assert!(check_paste_target(&intended, Some(7), Some(WEZ)).is_err());
        }
        let mut unflagged = terminal(Some(7), Some(WEZ));
        unflagged.paste_terminal = false;
        assert!(check_paste_target(&unflagged, Some(7), Some(WEZ)).is_err());
    }

    #[test]
    fn a_secure_target_is_never_pasted_into() {
        let mut secure = terminal(Some(7), Some(WEZ));
        secure.kind = "secure".into();
        assert!(check_paste_target(&secure, Some(7), Some(WEZ)).is_err());
    }
}

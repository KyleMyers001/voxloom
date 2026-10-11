//! Apple Terminal is a separate transport, never a web fallback.
use super::{choose_insert_path, InsertPath};
use crate::delivery::types::TargetSnapshotDto;

pub fn apple_terminal_host(exe: &str) -> bool {
    exe == "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"
}

pub fn choose_path(
    target: &TargetSnapshotDto,
    value_readable: bool,
    messages_host: bool,
    terminal: Option<bool>,
) -> InsertPath {
    let Some(terminal) = terminal else {
        return InsertPath::Refuse(
            "target executable identity unavailable — insert skipped".into(),
        );
    };
    if !terminal {
        return choose_insert_path(target, value_readable, messages_host);
    }
    if target.insertable
        && target.kind == "insertable"
        && target.element_role.as_deref() == Some("AXTextArea")
    {
        InsertPath::TerminalUnicode
    } else {
        InsertPath::Refuse("unsupported or unsafe Apple Terminal target".into())
    }
}

pub fn dispatch(
    text: &str,
    mut still_target: impl FnMut() -> Result<(), String>,
    mut post: impl FnMut(&[u16]) -> Result<(), String>,
) -> Result<super::InsertReport, String> {
    super::check_insert_text(text)?;
    if text
        .chars()
        .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
    {
        return Err("Terminal transcript contains control or line separator — nothing sent".into());
    }
    if text.encode_utf16().count() > 4096 {
        return Err("Terminal transcript exceeds 4096 UTF-16 units — nothing sent".into());
    }
    use super::report::TerminalDispatch;
    let start = std::time::Instant::now();
    let mut posted = 0;
    for chunk in super::utf16_chunks(text, super::KEY_EVENT_UTF16_MAX) {
        let check = if start.elapsed() >= std::time::Duration::from_secs(5) {
            Err("Terminal dispatch deadline exceeded".into())
        } else {
            still_target()
        };
        if let Err(error) = check.and_then(|()| post(&chunk)) {
            if posted == 0 {
                return Err(error);
            }
            return Ok(super::InsertReport {
                typed: true, unverified: true,
                terminal_dispatch: Some(TerminalDispatch::Partial),
                detail: Some(format!("{error}; stopped after {posted} chunks; input not verified; inspect before retrying")),
            });
        }
        posted += 1;
    }
    Ok(super::InsertReport {
        typed: true,
        unverified: true,
        terminal_dispatch: Some(TerminalDispatch::Complete),
        detail: Some(
            "Terminal events sent; input buffer not verified; inspect before retrying".into(),
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::delivery::decide::test_support::target;
    #[test]
    fn terminal_rejects_entire_unsafe_payload_before_any_events() {
        for ch in (0..=0x9f)
            .filter(|n| *n < 0x20 || *n >= 0x7f)
            .chain([0x2028, 0x2029])
            .map(|n| char::from_u32(n).unwrap())
        {
            let text = format!("{}{}suffix", "safe prefix ".repeat(8), ch);
            let mut events = 0;
            let result = dispatch(
                &text,
                || Ok(()),
                |_| {
                    events += 1;
                    Ok(())
                },
            );
            assert!(result.is_err(), "U+{:04X}", ch as u32);
            assert_eq!(events, 0);
        }
        for text in [String::new(), "x".repeat(4097)] {
            assert!(
                dispatch(&text, || panic!("preflight first"), |_| panic!("no events")).is_err()
            );
        }
    }

    #[test]
    fn terminal_posted_is_never_input_confirmed_and_partial_never_retries() {
        use super::super::report::TerminalDispatch;
        let text = "Voxloom ASCII abc XYZ 123 café 日本語 🙂 fin";
        let mut units = Vec::new();
        let report = dispatch(
            text,
            || Ok(()),
            |c| {
                units.extend_from_slice(c);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(String::from_utf16(&units).unwrap(), text);
        assert!(report.unverified);
        assert!(report.typed);
        assert_eq!(report.terminal_dispatch, Some(TerminalDispatch::Complete));
        let mut checks = 0;
        let mut events = 0;
        let report = dispatch(
            text,
            || {
                checks += 1;
                if checks > 1 {
                    Err("exact target changed".into())
                } else {
                    Ok(())
                }
            },
            |_| {
                events += 1;
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(events, 1);
        assert!(report.unverified);
        assert_eq!(report.terminal_dispatch, Some(TerminalDispatch::Partial));
        assert!(dispatch(
            text,
            || Err("permission/focus lost".into()),
            |_| panic!("no events")
        )
        .is_err());
        let mut attempts = 0;
        let report = dispatch(
            text,
            || Ok(()),
            |_| {
                attempts += 1;
                if attempts == 2 {
                    Err("allocation failed before post".into())
                } else {
                    Ok(())
                }
            },
        )
        .unwrap();
        assert_eq!(attempts, 2);
        assert_eq!(report.terminal_dispatch, Some(TerminalDispatch::Partial));
    }

    #[test]
    fn terminal_exact_identity_change_aborts_not_redirects() {
        let intended = target("insertable", Some(42), Some("42:AXTextArea:#1"));
        for current in [
            target("insertable", Some(42), Some("42:AXTextArea:unmatched")),
            target("insertable", Some(43), Some("43:AXTextArea:#1")),
            target("secure", Some(42), Some("42:AXTextArea:#1")),
            target("unavailable", None, None),
        ] {
            let checked = super::super::validate_snapshots(&intended, current);
            assert!(matches!(
                choose_path(&checked, true, false, Some(true)),
                InsertPath::Refuse(_)
            ));
            let result = dispatch(
                "hello",
                || {
                    if checked.insertable {
                        Ok(())
                    } else {
                        Err("identity/secure/trust refusal".into())
                    }
                },
                |_| panic!("must not post after exact target mismatch"),
            );
            assert!(result.is_err());
        }
    }

    #[test]
    fn terminal_routes_directly_only_for_exact_system_host_and_text_area() {
        let exe = "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal";
        assert!(apple_terminal_host(exe));
        for other in [
            "/Applications/Terminal.app/Contents/MacOS/Terminal",
            "",
            "/usr/bin/zsh",
        ] {
            assert!(!apple_terminal_host(other));
        }
        assert!(!crate::delivery::decide::unicode_typing_supported(
            exe,
            |_| false
        ));
        let mut t = target("insertable", Some(42), Some("42:AXTextArea:#1"));
        assert!(
            matches!(choose_path(&t, true, false, None), InsertPath::Refuse(_)),
            "unknown executable must not fall through to AX mutation"
        );
        assert_eq!(
            choose_path(&t, false, false, Some(true)),
            InsertPath::TerminalUnicode
        );
        assert_eq!(
            choose_path(&t, true, false, Some(false)),
            InsertPath::AxSelectedText
        );
        // Unreadable AXValue outside Messages: refused (BUS-14).
        assert!(matches!(
            choose_path(&t, false, false, Some(false)),
            InsertPath::Refuse(_)
        ));
        // Messages: guarded flow whether or not AXValue is readable.
        for readable in [true, false] {
            assert_eq!(
                choose_path(&t, readable, true, Some(false)),
                InsertPath::MessagesGuarded
            );
        }
        for role in ["AXTextField", "AXGroup", "AXWebArea", "AXSecureTextField"] {
            t.element_role = Some(role.into());
            assert!(matches!(
                choose_path(&t, true, false, Some(true)),
                InsertPath::Refuse(_)
            ));
        }
        t.element_role = Some("AXTextArea".into());
        t.kind = "secure".into();
        assert!(matches!(
            choose_path(&t, true, false, Some(true)),
            InsertPath::Refuse(_)
        ));
    }
}

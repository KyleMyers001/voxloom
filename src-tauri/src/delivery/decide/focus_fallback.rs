//! Fallback when the system-wide AX element reports no focused app/element
//! (e.g. ChatGPT: AXFocusedApplication=-25212). The macOS adapter then asks
//! the frontmost app (NSWorkspace) directly for its AXFocusedUIElement.
//! Pure decisions live here so they are unit-tested on any OS.

/// Waits before each fallback attempt (first attempt is immediate): ~150 ms max.
pub const FALLBACK_RETRY_MS: [u64; 3] = [0, 50, 100];

/// Why the fallback could not produce a target.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FallbackError {
    NoFrontmost,
    SelfFrontmost,
    /// Last AXError from the app element's AXFocusedUIElement (null => 0).
    AppFocus(i32, bool),
    /// The element found belongs to another process than the frontmost app.
    PidMismatch,
}

/// Which pid to query, never Voxloom itself (the overlay never takes focus,
/// so our own pid being frontmost means the real target is unknown).
pub fn fallback_pid(front: Option<i32>, own_pid: i32) -> Result<i32, FallbackError> {
    match front {
        None => Err(FallbackError::NoFrontmost),
        Some(pid) if pid == own_pid => Err(FallbackError::SelfFrontmost),
        Some(pid) => Ok(pid),
    }
}

/// Accept a fallback element only if it is non-null, read without error, and
/// owned by the frontmost pid we queried (fail closed otherwise).
pub fn accept_element(
    err: i32,
    null: bool,
    element_pid: Option<i32>,
    front: i32,
) -> Result<(), FallbackError> {
    if err != 0 || null {
        return Err(FallbackError::AppFocus(err, null));
    }
    if element_pid != Some(front) {
        return Err(FallbackError::PidMismatch);
    }
    Ok(())
}

/// Original system-wide message plus the fallback's own failure code.
pub fn with_fallback_error(reason: &str, front: Option<i32>, err: &FallbackError) -> String {
    let detail = match err {
        FallbackError::NoFrontmost => "no frontmost app".to_string(),
        FallbackError::SelfFrontmost => "frontmost app is Voxloom".to_string(),
        FallbackError::AppFocus(code, null) => {
            let n = if *null { " (null)" } else { "" };
            format!("app AXFocusedUIElement={code}{n}")
        }
        FallbackError::PidMismatch => "focused element not owned by frontmost app".to_string(),
    };
    let pid = front.map_or("none".to_string(), |p| p.to_string());
    format!("{reason}; frontmost fallback pid={pid}: {detail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_frontmost_pid_but_never_self_or_none() {
        assert_eq!(fallback_pid(Some(42), 7), Ok(42));
        assert_eq!(fallback_pid(Some(7), 7), Err(FallbackError::SelfFrontmost));
        assert_eq!(fallback_pid(None, 7), Err(FallbackError::NoFrontmost));
    }

    #[test]
    fn accepts_only_clean_element_owned_by_frontmost() {
        assert_eq!(accept_element(0, false, Some(42), 42), Ok(()));
        assert_eq!(
            accept_element(-25212, true, None, 42),
            Err(FallbackError::AppFocus(-25212, true))
        );
        assert_eq!(
            accept_element(0, true, None, 42),
            Err(FallbackError::AppFocus(0, true))
        );
        assert_eq!(
            accept_element(0, false, Some(9), 42),
            Err(FallbackError::PidMismatch)
        );
        assert_eq!(
            accept_element(0, false, None, 42),
            Err(FallbackError::PidMismatch)
        );
    }

    #[test]
    fn retry_is_short_and_starts_immediately() {
        assert_eq!(FALLBACK_RETRY_MS[0], 0);
        let total: u64 = FALLBACK_RETRY_MS.iter().sum();
        assert!((50..=150).contains(&total));
    }

    #[test]
    fn failure_keeps_original_message_and_adds_fallback_code() {
        let base = "Accessibility focus unavailable at delivery validation (AX trusted=yes; \
                    AXFocusedApplication=-25212; AXFocusedUIElement=-25212 (null))";
        let msg = with_fallback_error(base, Some(42), &FallbackError::AppFocus(-25204, false));
        assert!(msg.starts_with(base));
        assert!(msg.ends_with("frontmost fallback pid=42: app AXFocusedUIElement=-25204"));
        let msg = with_fallback_error(base, Some(7), &FallbackError::SelfFrontmost);
        assert!(msg.contains("frontmost app is Voxloom"));
        let msg = with_fallback_error(base, None, &FallbackError::NoFrontmost);
        assert!(msg.contains("pid=none: no frontmost app"));
    }
}

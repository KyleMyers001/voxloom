//! Fallback when the system-wide AX element reports no focused app/element
//! (e.g. ChatGPT: AXFocusedApplication=-25212). The macOS adapter then asks
//! the frontmost app (NSWorkspace) directly for its AXFocusedUIElement.
//! Pure decisions live here so they are unit-tested on any OS.

/// Waits before each fallback attempt (first attempt is immediate): ~150 ms max.
pub const FALLBACK_RETRY_MS: [u64; 3] = [0, 50, 100];
/// After setting the Electron/Chromium activation attribute the app builds
/// its AX tree asynchronously; allow a little longer (~500 ms total).
pub const ACTIVATED_RETRY_MS: [u64; 5] = [0, 50, 100, 150, 200];

pub fn retry_schedule(activated: bool) -> &'static [u64] {
    if activated {
        &ACTIVATED_RETRY_MS
    } else {
        &FALLBACK_RETRY_MS
    }
}

/// One fallback step, recorded for the HUD diagnostic (codes only, no text).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    /// Activation attribute write (`None` = host not allowlisted, not tried).
    Activate(Option<(&'static str, i32)>),
    /// App AXFocusedUIElement after `tries` reads; last error / null.
    AppFocus { tries: usize, err: i32, null: bool },
    /// Window walk: which window attribute and its error, then the outcome.
    Walk {
        window: &'static str,
        err: i32,
        outcome: Option<String>,
    },
}

impl Step {
    fn describe(&self) -> String {
        match self {
            Self::Activate(None) => "activation n/a (not Electron/Chromium)".into(),
            Self::Activate(Some((attr, err))) => format!("{attr} set={err}"),
            Self::AppFocus { tries, err, null } => {
                let n = if *null { " (null)" } else { "" };
                format!("app AXFocusedUIElement={err}{n} x{tries}")
            }
            Self::Walk {
                window,
                err,
                outcome,
            } => match outcome {
                Some(o) => format!("walk {window}: {o}"),
                None => format!("walk {window}={err}"),
            },
        }
    }
}

/// Original system-wide message plus every fallback step tried, in order.
pub fn with_fallback_trace(reason: &str, front: Option<i32>, steps: &[Step]) -> String {
    let pid = front.map_or("none".to_string(), |p| p.to_string());
    let detail: Vec<String> = steps.iter().map(Step::describe).collect();
    format!(
        "{reason}; frontmost fallback pid={pid}: {}",
        detail.join("; ")
    )
}

/// Why the fallback could not produce a target.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FallbackError {
    NoFrontmost,
    SelfFrontmost,
    /// Last AXError from the app element's AXFocusedUIElement (null => 0).
    AppFocus(i32, bool),
    /// The element found belongs to another process than the frontmost app.
    PidMismatch,
    /// The frontmost app changed while the element was being read/walked.
    FrontmostChanged,
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

/// Final gate before handing an element to insertion: the app we queried
/// must still be frontmost *after* the AX read/walk (fail closed), so text
/// never lands in a background app's field if focus moved mid-read.
pub fn still_frontmost(queried: i32, after: Option<i32>) -> Result<(), FallbackError> {
    if after == Some(queried) {
        Ok(())
    } else {
        Err(FallbackError::FrontmostChanged)
    }
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
        FallbackError::FrontmostChanged => "frontmost app changed during AX read".to_string(),
    };
    let pid = front.map_or("none".to_string(), |p| p.to_string());
    format!("{reason}; frontmost fallback pid={pid}: {detail}")
}

#[cfg(test)]
#[path = "focus_fallback_tests.rs"]
mod tests;

//! Pure web-AX policy (Chromium/Electron): when to (re)enable the web AX
//! tree and the bounded wait for the real focused field. No per-pid cache:
//! apps can silently drop accessibility while idle, so a "once per pid" flag
//! left them broken until restart (MacBook Air report, 2026-10-11).

/// Chromium and Electron debounce activation for about two seconds.
pub const BOOTSTRAP_READS: usize = 61;
pub const BOOTSTRAP_WAIT_MS: u64 = 40;

/// Focus that is only a web container (or nothing) needs the web AX tree.
pub fn needs_web_ax(focused_role: Option<&str>) -> bool {
    matches!(
        focused_role,
        None | Some("AXWebArea" | "AXGroup" | "AXScrollArea")
    )
}

/// One read of the bounded wait.
#[derive(Debug, PartialEq, Eq)]
pub enum Read<T, E> {
    Found(T),
    Retry(E),
    Abort(E),
}

/// Read until `Found`, an `Abort`, or `BOOTSTRAP_READS` attempts.
pub fn wait_for_focus<T, E>(
    mut read: impl FnMut() -> Read<T, E>,
    mut wait: impl FnMut(),
) -> Result<T, E> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        match read() {
            Read::Found(v) => return Ok(v),
            Read::Abort(e) => return Err(e),
            Read::Retry(e) if attempt >= BOOTSTRAP_READS => return Err(e),
            Read::Retry(_) => wait(),
        }
    }
}

/// The wait may run only for a trusted, allowlisted, frontmost host whose
/// focused element (if any) belongs to that same pid.
pub fn bootstrap_allowed(
    trusted: bool,
    known_host: bool,
    front: Option<i32>,
    focus: Option<i32>,
) -> bool {
    trusted && known_host && front.is_some_and(|pid| pid > 0 && focus.is_none_or(|p| p == pid))
}

/// Re-assert the activation attribute. Called on EVERY insert attempt; there
/// is deliberately no memory of earlier successes. `set` performs the AX write.
pub fn reassert_with<A>(
    pid: Option<i32>,
    activation: Option<A>,
    trusted: bool,
    set: impl FnOnce(i32, A) -> bool,
) -> bool {
    match (pid.filter(|p| *p > 0), activation) {
        (Some(pid), Some(activation)) if trusted => set(pid, activation),
        _ => false,
    }
}

/// Document identity captured at completion and on every wait poll.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DocIds {
    /// AXDocument of the app's focused window (native; works without web AX).
    pub window_doc: Option<String>,
    /// AXURL (or AXDocument) of the web area containing focus.
    pub area_url: Option<String>,
}

/// The late field may be used only if the focused window is the same element
/// (`same_window`: CFEqual; `None` = unreadable on either side => abort) and
/// every identity known at completion is unchanged. The web area URL is often
/// unknown until the tree is enabled; once the field is found, its area URL
/// must match a URL captured at completion.
pub fn context_holds(same_window: Option<bool>, start: &DocIds, now: &DocIds, found: bool) -> bool {
    if same_window != Some(true) {
        return false;
    }
    if start.window_doc.is_some() && now.window_doc != start.window_doc {
        return false;
    }
    match &start.area_url {
        Some(url) if found || now.area_url.is_some() => now.area_url.as_ref() == Some(url),
        _ => true,
    }
}

#[cfg(test)]
#[path = "web_ax_tests.rs"]
mod tests;

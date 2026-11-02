//! Warm cache for the frontmost-app focus fallback: one retained element for
//! the current delivery. Set on a successful fallback, cleared by `clear()`
//! when `insert_text` returns (success or failure) or validation refuses, and
//! bounded by `WARM_TTL_MS` as a backstop. Policy: `decide::focus_cache`.

use std::sync::Mutex;
use std::time::Instant;

use super::ax::*;
use super::focus::now_ms;
use super::focus_walk::{Live, Node};
use super::host;
use crate::delivery::decide::focus_cache::{cached_ok, plan, Warm};
use crate::delivery::decide::focus_walk::AxTree;

/// Warm state plus the retained element (as usize: CF refs are thread-safe to
/// retain/release; the AX element is immutable).
static WARM: Mutex<Option<(Warm, usize)>> = Mutex::new(None);

pub fn warm_state() -> Option<Warm> {
    WARM.lock()
        .unwrap_or_else(|e| e.into_inner())
        .map(|(w, _)| w)
}

pub fn remember(pid: i32, el: AXUIElementRef) {
    let kept = unsafe { CFRetain(el as CFTypeRef) } as usize;
    let mut w = WARM.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, old)) = w.replace((
        Warm {
            pid,
            at_ms: now_ms(),
        },
        kept,
    )) {
        release(old as CFTypeRef);
    }
}

/// Drop the cached element; the next fallback runs cold.
pub fn clear() {
    let old = WARM.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some((_, el)) = old {
        release(el as CFTypeRef);
    }
}

/// CFEqual of the field's AXWindow and the app's AXFocusedWindow; None if
/// either is unreadable (caller fails closed).
fn same_window(el: CFTypeRef, app: CFTypeRef) -> Option<bool> {
    let win = copy_attr(el as AXUIElementRef, "AXWindow").ok()?;
    let focused = match copy_attr(app as AXUIElementRef, "AXFocusedWindow") {
        Ok(f) => f,
        Err(_) => {
            release(win);
            return None;
        }
    };
    let eq = unsafe { CFEqual(win, focused) } != 0;
    release(win);
    release(focused);
    Some(eq)
}

/// Cached element if warm for `pid`, still focused, in the app's focused
/// window, and the app is still frontmost (+1 retain).
pub fn cached(pid: i32, app: CFTypeRef) -> Option<AXUIElementRef> {
    let el = {
        let w = WARM.lock().unwrap_or_else(|e| e.into_inner());
        let (warm, el) = (*w)?;
        if !plan(Some(warm), pid, now_ms()).try_cached {
            return None;
        }
        Node(unsafe { CFRetain(el as CFTypeRef) })
    };
    let mut live = Live(Instant::now());
    let ok = cached_ok(
        live.is_focused(&el),
        live.pid(&el),
        host::frontmost_pid(),
        pid,
        same_window(el.0, app),
    );
    ok.then(|| el.into_raw())
}

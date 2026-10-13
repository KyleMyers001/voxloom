//! Frontmost-app focus fallback (AX side). Used when the system-wide element
//! has no focused element (ChatGPT desktop, Electron: -25212 kAXErrorNoValue).
//! Cold (first lookup of a delivery): set the host's web-AX activation
//! attribute (allowlisted hosts only), retry the app's AXFocusedUIElement
//! (≤ ~0.5 s), then walk the focused/main window. Warm (same pid, within
//! `WARM_TTL_MS`, cleared when a delivery ends): re-check the cached element, then one read and the walk.
//! Policy: `decide::{focus_fallback, focus_walk, focus_cache}`. Only reached
//! from async Tauri commands, never the main thread.

use std::time::Instant;

use super::ax::*;
use super::focus::now_ms;
use super::focus_walk::{set_timeout, Live, Node};
use super::focus_warm::{cached, remember, warm_state};
use super::host;
use crate::delivery::decide::focus_cache::plan;
use crate::delivery::decide::focus_fallback::{
    accept_element, fallback_pid, retry_schedule, with_fallback_error, with_fallback_trace,
    FallbackError, Step,
};
use crate::delivery::decide::focus_walk::{find_focused, AxTree, WalkOutcome};

type Focus = Result<(AXUIElementRef, Option<String>), String>;

/// Never Voxloom's own pid; every failure is fail-closed with a full trace.
pub fn frontmost_app_focus(reason: &str) -> Focus {
    let front = host::frontmost_pid();
    let own = std::process::id() as i32;
    let pid = fallback_pid(front, own).map_err(|e| with_fallback_error(reason, front, &e))?;
    let plan = plan(warm_state(), pid, now_ms());
    let app = unsafe { AXUIElementCreateApplication(pid) };
    if app.is_null() {
        return Err(with_fallback_trace(reason, front, &[]));
    }
    let app = Node(app as CFTypeRef);
    set_timeout(app.0);
    if plan.try_cached {
        if let Some(el) = cached(pid, app.0) {
            return found(pid, el, &app);
        }
    }
    let mut steps = Vec::new();
    let mut long = false;
    if plan.activate {
        let activated = host::web_ax_activation(pid).map(|a| {
            (
                a.attribute(),
                set_web_accessibility(app.0 as AXUIElementRef, a),
            )
        });
        long = activated.is_some_and(|(_, e)| e == AX_OK);
        steps.push(Step::Activate(activated));
    }
    let schedule = if plan.long_retry {
        retry_schedule(long)
    } else {
        &[0][..]
    };
    let (mut last_err, mut last_null) = (0, true);
    for (i, wait) in schedule.iter().enumerate() {
        if *wait > 0 {
            std::thread::sleep(std::time::Duration::from_millis(*wait));
        }
        if host::frontmost_pid() != Some(pid) {
            steps.push(Step::AppFocus {
                tries: i,
                err: last_err,
                null: last_null,
            });
            return Err(with_fallback_trace(reason, front, &steps) + "; frontmost app changed");
        }
        let (err, focused) = copy_focus_of(app.0 as AXUIElementRef);
        let owner = (!focused.is_null())
            .then(|| element_pid(focused as _))
            .flatten();
        match accept_element(err, focused.is_null(), owner, pid) {
            Ok(()) => return found(pid, focused as AXUIElementRef, &app),
            Err(e) => {
                release(focused);
                (last_err, last_null) = (err, focused.is_null());
                if e == FallbackError::PidMismatch {
                    steps.push(Step::AppFocus {
                        tries: i + 1,
                        err,
                        null: false,
                    });
                    return Err(with_fallback_trace(reason, front, &steps)
                        + "; focused element not owned by frontmost app");
                }
            }
        }
    }
    steps.push(Step::AppFocus {
        tries: schedule.len(),
        err: last_err,
        null: last_null,
    });
    walk_windows(reason, front, pid, &app, steps)
}

/// Walk the focused window, then the main window (frontmost checked before
/// and after each walk).
fn walk_windows(
    reason: &str,
    front: Option<i32>,
    pid: i32,
    app: &Node,
    mut steps: Vec<Step>,
) -> Focus {
    for window in ["AXFocusedWindow", "AXMainWindow"] {
        if host::frontmost_pid() != Some(pid) {
            steps.push(Step::Walk {
                window,
                err: 0,
                outcome: Some("frontmost app changed".into()),
            });
            break;
        }
        let root = match copy_attr(app.0 as AXUIElementRef, window) {
            Ok(w) => Node(w),
            Err(err) => {
                steps.push(Step::Walk {
                    window,
                    err,
                    outcome: None,
                });
                continue;
            }
        };
        set_timeout(root.0);
        let outcome = find_focused(&mut Live(Instant::now()), root, pid);
        let text = outcome.describe();
        let stop = !matches!(
            outcome,
            WalkOutcome::NotFound { .. } | WalkOutcome::Budget { .. }
        );
        if let WalkOutcome::Found(node) = outcome {
            if host::frontmost_pid() == Some(pid) {
                return found(pid, node.into_raw(), app);
            }
            steps.push(Step::Walk {
                window,
                err: 0,
                outcome: Some("frontmost app changed".into()),
            });
            break;
        }
        steps.push(Step::Walk {
            window,
            err: 0,
            outcome: Some(text),
        });
        if stop {
            break; // secure field or foreign owner: refuse
        }
    }
    Err(with_fallback_trace(reason, front, &steps))
}

fn found(pid: i32, el: AXUIElementRef, app: &Node) -> Focus {
    remember(pid, el);
    Ok((el, copy_string_attr(app.0 as AXUIElementRef, "AXTitle")))
}

fn copy_focus_of(element: AXUIElementRef) -> (AXError, CFTypeRef) {
    let name = cfstr("AXFocusedUIElement");
    let mut focused: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(element, name, &mut focused) };
    release(name);
    if !focused.is_null() {
        set_timeout(focused); // 0.25 s, also for later cached reads
    }
    (err, focused)
}

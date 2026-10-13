//! Frontmost-app focus fallback (AX side). Used when the system-wide element
//! has no focused element (ChatGPT desktop, Electron: -25212 kAXErrorNoValue).
//! 1. set the host's web-AX activation attribute (allowlisted hosts only),
//! 2. retry the app's AXFocusedUIElement briefly,
//! 3. walk the focused/main window for an AXFocused insertable field.
//! Policy lives in `decide::focus_fallback` / `decide::focus_walk`.
//! Sleeps ≤ ~0.5 s + walk budget; only reached from async Tauri commands.

use std::time::Instant;

use super::ax::*;
use super::host;
use crate::delivery::decide::focus_fallback::{
    accept_element, fallback_pid, retry_schedule, with_fallback_error, with_fallback_trace,
    FallbackError, Step,
};
use crate::delivery::decide::focus_walk::{find_focused, AxTree, WalkOutcome};

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFArrayGetCount(array: CFTypeRef) -> isize;
    fn CFArrayGetValueAtIndex(array: CFTypeRef, idx: isize) -> CFTypeRef;
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFArrayGetTypeID() -> usize;
    static kCFBooleanTrue: CFTypeRef;
}

type Focus = Result<(AXUIElementRef, Option<String>), String>;

/// Owned AX reference; dropping releases it.
pub struct Node(CFTypeRef);

impl Drop for Node {
    fn drop(&mut self) {
        release(self.0);
    }
}

impl Node {
    fn into_raw(self) -> AXUIElementRef {
        let raw = self.0 as AXUIElementRef;
        std::mem::forget(self);
        raw
    }
}

struct Live(Instant);

impl AxTree for Live {
    type Node = Node;
    fn children(&mut self, n: &Node) -> Vec<Node> {
        let Ok(arr) = copy_attr(n.0 as AXUIElementRef, "AXChildren") else {
            return Vec::new();
        };
        let arr = Node(arr);
        if unsafe { CFGetTypeID(arr.0) != CFArrayGetTypeID() } {
            return Vec::new();
        }
        let count = unsafe { CFArrayGetCount(arr.0) }.max(0);
        (0..count)
            .filter_map(|i| {
                let v = unsafe { CFArrayGetValueAtIndex(arr.0, i) };
                (!v.is_null()).then(|| Node(unsafe { CFRetain(v) }))
            })
            .collect()
    }
    fn is_focused(&mut self, n: &Node) -> bool {
        match copy_attr(n.0 as AXUIElementRef, "AXFocused") {
            Ok(v) => {
                let yes = unsafe { CFEqual(v, kCFBooleanTrue) } != 0;
                release(v);
                yes
            }
            Err(_) => false,
        }
    }
    fn role(&mut self, n: &Node) -> Option<String> {
        copy_string_attr(n.0 as AXUIElementRef, "AXRole")
    }
    fn subrole(&mut self, n: &Node) -> Option<String> {
        copy_string_attr(n.0 as AXUIElementRef, "AXSubrole")
    }
    fn pid(&mut self, n: &Node) -> Option<i32> {
        element_pid(n.0 as AXUIElementRef)
    }
    fn elapsed_ms(&self) -> u64 {
        self.0.elapsed().as_millis() as u64
    }
}

/// Never Voxloom's own pid; every failure is fail-closed with a full trace.
pub fn frontmost_app_focus(reason: &str) -> Focus {
    let front = host::frontmost_pid();
    let own = std::process::id() as i32;
    let pid = fallback_pid(front, own).map_err(|e| with_fallback_error(reason, front, &e))?;
    let app = unsafe { AXUIElementCreateApplication(pid) };
    if app.is_null() {
        return Err(with_fallback_trace(reason, front, &[]));
    }
    let app = Node(app as CFTypeRef);
    let mut steps = Vec::new();

    // (a) Electron/Chromium build their AX tree only when asked.
    let activation = host::web_ax_activation(pid);
    let activated = activation.map(|a| {
        let err = set_web_accessibility(app.0 as AXUIElementRef, a);
        (a.attribute(), err)
    });
    steps.push(Step::Activate(activated));
    let schedule = retry_schedule(activated.is_some_and(|(_, e)| e == AX_OK));

    let (mut last_err, mut last_null) = (0, true);
    for (i, wait) in schedule.iter().enumerate() {
        if *wait > 0 {
            std::thread::sleep(std::time::Duration::from_millis(*wait));
        }
        if host::frontmost_pid() != Some(pid) {
            steps.push(Step::AppFocus {
                tries: i + 1,
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
            Ok(()) => return Ok((focused as AXUIElementRef, title(&app))),
            Err(FallbackError::PidMismatch) => {
                release(focused);
                steps.push(Step::AppFocus {
                    tries: i + 1,
                    err,
                    null: false,
                });
                return Err(with_fallback_trace(reason, front, &steps)
                    + "; focused element not owned by frontmost app");
            }
            Err(_) => {
                release(focused);
                (last_err, last_null) = (err, focused.is_null());
            }
        }
    }
    steps.push(Step::AppFocus {
        tries: schedule.len(),
        err: last_err,
        null: last_null,
    });

    // (b) Walk the focused window, then the main window.
    for window in ["AXFocusedWindow", "AXMainWindow"] {
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
        let outcome = find_focused(&mut Live(Instant::now()), root, pid);
        let text = outcome.describe();
        match outcome {
            WalkOutcome::Found(node) if host::frontmost_pid() == Some(pid) => {
                return Ok((node.into_raw(), title(&app)));
            }
            WalkOutcome::Found(_) => {
                steps.push(Step::Walk {
                    window,
                    err: 0,
                    outcome: Some("frontmost app changed".into()),
                });
                break;
            }
            WalkOutcome::NotFound { .. } | WalkOutcome::Budget { .. } => {
                steps.push(Step::Walk {
                    window,
                    err: 0,
                    outcome: Some(text),
                });
            }
            // Secure field or foreign owner: stop, refuse.
            WalkOutcome::Secure | WalkOutcome::PidMismatch => {
                steps.push(Step::Walk {
                    window,
                    err: 0,
                    outcome: Some(text),
                });
                break;
            }
        }
    }
    Err(with_fallback_trace(reason, front, &steps))
}

fn title(app: &Node) -> Option<String> {
    copy_string_attr(app.0 as AXUIElementRef, "AXTitle")
}

fn copy_focus_of(element: AXUIElementRef) -> (AXError, CFTypeRef) {
    let name = cfstr("AXFocusedUIElement");
    let mut focused: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(element, name, &mut focused) };
    release(name);
    (err, focused)
}

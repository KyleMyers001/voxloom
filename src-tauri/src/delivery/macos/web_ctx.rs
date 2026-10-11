//! Window/document identity for the bounded web-AX wait: the focused window
//! (CFEqual) plus its AXDocument and the web area's AXURL, captured at
//! completion and required unchanged on every poll and on the field found.

use super::ax::*;
use crate::delivery::decide::web_ax::{context_holds, DocIds};

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFURLGetString(url: CFTypeRef) -> CFStringRef;
    fn CFURLGetTypeID() -> usize;
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
}

/// Owned focused-window reference plus document identity.
pub struct WebContext {
    window: CFTypeRef,
    ids: DocIds,
}

impl Drop for WebContext {
    fn drop(&mut self) {
        release(self.window);
    }
}

fn url_attr(el: AXUIElementRef) -> Option<String> {
    let value = copy_attr(el, "AXURL").ok()?;
    let out = unsafe {
        if CFGetTypeID(value) == CFURLGetTypeID() {
            cfstring_to_rust(CFURLGetString(value)) // Get rule: not owned.
        } else {
            None
        }
    };
    release(value);
    out.or_else(|| copy_string_attr(el, "AXDocument"))
}

/// URL of the nearest AXWebArea at or above `el`.
fn web_area_url(el: AXUIElementRef) -> Option<String> {
    if copy_string_attr(el, "AXRole").as_deref() == Some("AXWebArea") {
        return url_attr(el);
    }
    let mut owned: CFTypeRef = std::ptr::null();
    let mut cursor = el;
    let mut url = None;
    for _ in 0..32 {
        let Ok(parent) = copy_attr(cursor, "AXParent") else {
            break;
        };
        release(owned);
        owned = parent;
        cursor = parent as AXUIElementRef;
        if copy_string_attr(cursor, "AXRole").as_deref() == Some("AXWebArea") {
            url = url_attr(cursor);
            break;
        }
    }
    release(owned);
    url
}

/// Capture for `pid`; `focus` is the focused element, if any.
pub fn capture(pid: i32, focus: Option<AXUIElementRef>) -> WebContext {
    let app = unsafe { AXUIElementCreateApplication(pid) };
    let window = if app.is_null() {
        std::ptr::null()
    } else {
        let w = copy_attr(app, "AXFocusedWindow").unwrap_or(std::ptr::null());
        release(app as CFTypeRef);
        w
    };
    let window_doc = (!window.is_null())
        .then(|| copy_string_attr(window as AXUIElementRef, "AXDocument"))
        .flatten();
    WebContext {
        window,
        ids: DocIds {
            window_doc,
            area_url: focus.and_then(web_area_url),
        },
    }
}

/// Whether the context still matches `start` (see `context_holds`).
pub fn holds(start: &WebContext, pid: i32, focus: Option<AXUIElementRef>, found: bool) -> bool {
    let now = capture(pid, focus);
    let same_window = (!start.window.is_null() && !now.window.is_null())
        .then(|| unsafe { CFEqual(start.window, now.window) } != 0);
    context_holds(same_window, &start.ids, &now.ids, found)
}

//! AX adapter for `decide::focus_walk`: owned nodes and a live tree whose
//! reads use a short messaging timeout so a hung app cannot stall delivery.

use std::time::Instant;

use super::ax::*;
use crate::delivery::decide::focus_walk::AxTree;

/// Per-element AX messaging timeout (seconds) for fallback reads.
pub const AX_TIMEOUT_S: f32 = 0.25;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout: f32) -> AXError;
}

pub fn set_timeout(element: CFTypeRef) {
    unsafe { AXUIElementSetMessagingTimeout(element as AXUIElementRef, AX_TIMEOUT_S) };
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFArrayGetCount(array: CFTypeRef) -> isize;
    fn CFArrayGetValueAtIndex(array: CFTypeRef, idx: isize) -> CFTypeRef;
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFArrayGetTypeID() -> usize;
    static kCFBooleanTrue: CFTypeRef;
}

/// Owned AX reference; dropping releases it.
pub struct Node(pub CFTypeRef);

impl Drop for Node {
    fn drop(&mut self) {
        release(self.0);
    }
}

impl Node {
    pub fn into_raw(self) -> AXUIElementRef {
        let raw = self.0 as AXUIElementRef;
        std::mem::forget(self);
        raw
    }
}

pub struct Live(pub Instant);

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
                (!v.is_null()).then(|| {
                    let n = Node(unsafe { CFRetain(v) });
                    set_timeout(n.0);
                    n
                })
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

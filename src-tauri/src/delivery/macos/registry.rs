//! Native identity of the completion-time target: the AX element is retained
//! and later focus is compared with CFEqual. Stable across scroll, reflow and
//! resize; distinct for sibling fields that share every attribute.

use std::sync::Mutex;

use super::ax::{release, AXUIElementRef, CFEqual, CFRetain, CFTypeRef};

struct Slot {
    generation: u64,
    element: usize, // retained AXUIElementRef (stored as usize for Send)
}

static SLOT: Mutex<Option<Slot>> = Mutex::new(None);
static NEXT: Mutex<u64> = Mutex::new(0);

/// Retain `element` as the intended target; returns its generation.
pub fn register(element: AXUIElementRef) -> Option<u64> {
    let generation = {
        let mut next = NEXT.lock().ok()?;
        *next += 1;
        *next
    };
    let retained = unsafe { CFRetain(element as CFTypeRef) };
    let mut slot = SLOT.lock().ok()?;
    if let Some(old) = slot.take() {
        release(old.element as CFTypeRef);
    }
    *slot = Some(Slot {
        generation,
        element: retained as usize,
    });
    Some(generation)
}

/// Generation of the registered element if `element` is that same element.
pub fn matching_generation(element: AXUIElementRef) -> Option<u64> {
    let slot = SLOT.lock().ok()?;
    let s = slot.as_ref()?;
    (unsafe { CFEqual(s.element as CFTypeRef, element as CFTypeRef) } != 0).then_some(s.generation)
}

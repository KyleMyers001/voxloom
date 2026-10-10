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

#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;

/// Retain `element` as the intended target; returns its generation.
pub fn register(element: AXUIElementRef) -> Option<u64> {
    register_in(element, &SLOT, &NEXT)
}

fn register_in(
    element: AXUIElementRef,
    slots: &Mutex<Option<Slot>>,
    next: &Mutex<u64>,
) -> Option<u64> {
    let generation = {
        let mut next = next.lock().ok()?;
        *next += 1;
        *next
    };
    // Do not acquire ownership until the slot can accept it (poison fails closed).
    let mut slot = slots.lock().ok()?;
    let retained = unsafe { CFRetain(element as CFTypeRef) };
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
    matching_generation_in(element, &SLOT)
}

fn matching_generation_in(element: AXUIElementRef, slots: &Mutex<Option<Slot>>) -> Option<u64> {
    let slot = slots.lock().ok()?;
    let s = slot.as_ref()?;
    (unsafe { CFEqual(s.element as CFTypeRef, element as CFTypeRef) } != 0).then_some(s.generation)
}

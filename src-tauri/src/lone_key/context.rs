//! The armed listener's state: one `Context` per arming, owned by `ACTIVE`
//! on the tap's own thread (see `crate::tap_thread`) and found by
//! generation, never by address.

use super::delivery::{Delivery, Generations};
use super::machine::{Edge, Kind, LoneKeyMachine, DEBOUNCE_MS};
use super::tap_ffi::*;
use super::LoneKey;
use std::{
    cell::{Cell, RefCell},
    ptr,
    rc::Rc,
    sync::LazyLock,
    time::Instant,
};

/// Current listener generation, shared with wake-ups and the delivery thread.
pub(super) static LIVE: LazyLock<Generations> = LazyLock::new(Generations::default);

pub(super) struct Context {
    /// Id of this arming; the tap's `info` carries it (never a pointer).
    pub(super) generation: u64,
    machine: RefCell<LoneKeyMachine>,
    delivery: Delivery,
    started: Instant,
    /// A debounce wake-up is already queued.
    tick_queued: Cell<bool>,
}

pub(super) struct Tap {
    pub(super) port: Handle,
    pub(super) source: Handle,
    pub(super) context: Rc<Context>,
}

thread_local! {
    pub(super) static ACTIVE: RefCell<Option<Tap>> = const { RefCell::new(None) };
}

impl Context {
    pub(super) fn new(generation: u64, key: LoneKey, delivery: Delivery) -> Self {
        Self {
            generation,
            machine: RefCell::new(LoneKeyMachine::new(key)),
            delivery,
            started: Instant::now(),
            tick_queued: Cell::new(false),
        }
    }

    fn now(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    /// Feed one tap event to the machine and queue what it emits.
    pub(super) fn step(&self, kind: Kind, keycode: u16, flags: u64) {
        let edges = self
            .machine
            .borrow_mut()
            .step(kind, keycode, flags, self.now());
        self.emit(edges);
    }

    fn emit(&self, edges: Vec<Edge>) {
        self.delivery.send(edges);
        // A press waits out the debounce even if no key event follows.
        let pending = self.machine.borrow().pending_since();
        if let (Some(since), false) = (pending, self.tick_queued.get()) {
            self.tick_queued.set(true);
            let wait = DEBOUNCE_MS.saturating_sub(self.now().saturating_sub(since));
            self.queue_tick(wait);
        }
    }

    /// No event arrives while a modifier is simply held, so wake this tap
    /// thread after the debounce with a one-shot timer on its run loop.
    fn queue_tick(&self, wait_ms: u64) {
        let mut timer_context = TimerContext {
            version: 0,
            info: self.generation as usize as Handle,
            retain: ptr::null(),
            release: ptr::null(),
            copy_description: ptr::null(),
        };
        // SAFETY: called on the tap thread (from its callback or a tick).
        // `info` is the generation, not a pointer; CF copies the context.
        // The run loop retains the timer, so ours is released at once; a
        // one-shot timer is invalidated after it fires.
        unsafe {
            let fire_at = CFAbsoluteTimeGetCurrent() + wait_ms as f64 / 1000.0;
            let timer = CFRunLoopTimerCreate(
                ptr::null_mut(),
                fire_at,
                0.0,
                0,
                0,
                on_tick,
                &mut timer_context,
            );
            if timer.is_null() {
                // The next key or mouse event still steps the machine.
                self.tick_queued.set(false);
                return;
            }
            CFRunLoopAddTimer(CFRunLoopGetCurrent(), timer, kCFRunLoopCommonModes);
            CFRelease(timer);
        }
    }
}

unsafe extern "C" fn on_tick(_timer: Handle, info: Handle) {
    tick(info as usize as u64);
}

/// The armed context, only if it is `generation` and still current (a
/// wake-up or event from before a re-arm must not touch the new listener).
pub(super) fn active_context(generation: u64) -> Option<Rc<Context>> {
    let context = ACTIVE.with(|slot| Some(slot.borrow().as_ref()?.context.clone()))?;
    (context.generation == generation && LIVE.is_current(generation)).then_some(context)
}

fn tick(generation: u64) {
    let Some(context) = active_context(generation) else {
        return;
    };
    context.tick_queued.set(false);
    let edges = context.machine.borrow_mut().tick(context.now());
    context.emit(edges);
}

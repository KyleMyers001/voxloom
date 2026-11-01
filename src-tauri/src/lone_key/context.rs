//! The armed listener's state: one `Context` per arming, owned by `ACTIVE`
//! (main thread only) and found by generation, never by address.

use super::delivery::{Delivery, Generations};
use super::machine::{Edge, Kind, LoneKeyMachine, DEBOUNCE_MS};
use super::tap_ffi::Handle;
use super::LoneKey;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::LazyLock,
    time::{Duration, Instant},
};
use tauri::AppHandle;

/// Current listener generation, shared with wake-ups and the delivery thread.
pub(super) static LIVE: LazyLock<Generations> = LazyLock::new(Generations::default);

pub(super) struct Context {
    app: AppHandle,
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
    pub(super) fn new(app: AppHandle, generation: u64, key: LoneKey, delivery: Delivery) -> Self {
        Self {
            app,
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

    /// No event arrives while a modifier is simply held, so wake the main
    /// thread after the debounce (a short-lived thread per press).
    fn queue_tick(&self, wait_ms: u64) {
        let app = self.app.clone();
        let generation = self.generation;
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(wait_ms));
            let _ = app.run_on_main_thread(move || tick(generation));
        });
    }
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

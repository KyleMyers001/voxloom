//! Pure lone-key state machine: no OS calls, so it runs on every platform.
//!
//! Feed it each event from the tap plus a monotonic `now` in ms. A press
//! becomes `Pressed` only after `DEBOUNCE_MS` clean milliseconds, so a chord
//! whose second key follows quickly (Option+E) never flickers. A release
//! before then is a quick tap and emits both edges at once.
//!
//! A press is *dirty* once anything else joins it: another key, a mouse
//! button, or a second modifier (or one already held at press time). A dirty
//! press that never emitted Pressed emits nothing. One that did emits
//! `Released` (the gesture machine finishes a hold normally) then
//! `Cancelled` (slice 3 maps it to `resetPartial`, so the interrupted tap is
//! not remembered as the first half of a double-tap).
//!
//! Other keys still down are tracked (bounded, expiring), so rolling from a
//! held key into our key (E held, then Option tapped) is a chord too.

use super::LoneKey;

/// Clean hold time before `Pressed` is emitted.
pub const DEBOUNCE_MS: u64 = 80;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    KeyDown,
    /// An auto-repeat keyDown. Never starts or changes a press of our key,
    /// so a key repeating across a tap re-enable can't fake one.
    KeyRepeat,
    KeyUp,
    FlagsChanged,
    MouseDown,
    /// The tap was disabled (timeout or user input): events were missed.
    TapDisabled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Pressed,
    Released,
    /// Discard the interrupted press (see module docs).
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Idle,
    /// Down and clean since `now`; `Pressed` not emitted yet.
    Pending(u64),
    Active,
    /// Chord or interrupted; waits for the key to come up.
    Dirty,
}

/// Other keys tracked at once; more than a keyboard can really hold.
const MAX_HELD: usize = 16;
/// A held key unseen (no repeat, no keyUp) this long is forgotten, so one
/// lost keyUp can't pin the shortcut as a chord forever.
const HELD_STALE_MS: u64 = 10_000;

pub struct LoneKeyMachine {
    key: LoneKey,
    phase: Phase,
    /// Non-target keys currently down, with when each was last seen.
    held: Vec<(u16, u64)>,
}

impl LoneKeyMachine {
    pub fn new(key: LoneKey) -> Self {
        Self {
            key,
            phase: Phase::Idle,
            held: Vec::new(),
        }
    }

    /// When the current press became clean-pending, if `Pressed` is due.
    pub fn pending_since(&self) -> Option<u64> {
        match self.phase {
            Phase::Pending(since) => Some(since),
            _ => None,
        }
    }

    /// Time passing with no event: emits `Pressed` once the debounce is over.
    pub fn tick(&mut self, now: u64) -> Vec<Edge> {
        match self.phase {
            Phase::Pending(since) if now.saturating_sub(since) >= DEBOUNCE_MS => {
                self.phase = Phase::Active;
                vec![Edge::Pressed]
            }
            _ => Vec::new(),
        }
    }

    pub fn step(&mut self, kind: Kind, keycode: u16, flags: u64, now: u64) -> Vec<Edge> {
        if kind == Kind::TapDisabled {
            // Events were lost, so we can't know what is still down. Decide
            // before any tick: a press merely waiting out the debounce is
            // dropped, only an emitted Pressed needs closing.
            let mut out = Vec::new();
            if self.phase == Phase::Active {
                out.extend([Edge::Released, Edge::Cancelled]);
            }
            self.phase = Phase::Idle;
            self.held.clear();
            return out;
        }
        let own = keycode == self.key.keycode;
        let own_f_key = own && !self.key.is_modifier();
        let own_modifier = own && self.key.is_modifier();
        // Something joined the press: decide before any tick. A press still
        // waiting out the debounce (even if a stalled tick is late) is simply
        // dropped; only an emitted Pressed needs closing.
        let joined = match kind {
            Kind::MouseDown => true,
            Kind::KeyDown | Kind::KeyRepeat => !own_f_key,
            Kind::FlagsChanged => !own_modifier && self.key.other_modifiers(flags) != 0,
            Kind::KeyUp | Kind::TapDisabled => false,
        };
        let mut out = Vec::new();
        if joined {
            if matches!(kind, Kind::KeyDown | Kind::KeyRepeat) {
                self.note_held(keycode, now);
            }
            self.make_dirty(&mut out);
            return out;
        }
        out.extend(self.tick(now));
        match kind {
            Kind::KeyDown if own_f_key => self.press(flags, now),
            Kind::KeyUp if own_f_key => self.release(&mut out),
            Kind::KeyUp => self.held.retain(|&(held, _)| held != keycode),
            Kind::FlagsChanged if own_modifier => {
                if flags & self.key.device_mask != 0 {
                    self.press(flags, now);
                } else {
                    self.release(&mut out);
                }
            }
            // Own-key repeats, other modifier changes that add nothing.
            _ => {}
        }
        out
    }

    fn note_held(&mut self, keycode: u16, now: u64) {
        if let Some(entry) = self.held.iter_mut().find(|(held, _)| *held == keycode) {
            entry.1 = now;
            return;
        }
        if self.held.len() >= MAX_HELD {
            // Full: forget the stale ones so a real key still gets a slot.
            self.prune(now);
        }
        if self.held.len() < MAX_HELD {
            self.held.push((keycode, now));
        }
    }

    fn prune(&mut self, now: u64) {
        self.held
            .retain(|&(_, seen)| now.saturating_sub(seen) < HELD_STALE_MS);
    }

    /// Our key went down. Repeats while already down are ignored.
    fn press(&mut self, flags: u64, now: u64) {
        if self.phase != Phase::Idle {
            return;
        }
        self.prune(now);
        self.phase = if self.key.other_modifiers(flags) != 0 || !self.held.is_empty() {
            Phase::Dirty
        } else {
            Phase::Pending(now)
        };
    }

    fn release(&mut self, out: &mut Vec<Edge>) {
        match self.phase {
            Phase::Pending(_) => out.extend([Edge::Pressed, Edge::Released]),
            Phase::Active => out.push(Edge::Released),
            Phase::Idle | Phase::Dirty => {}
        }
        self.phase = Phase::Idle;
    }

    fn make_dirty(&mut self, out: &mut Vec<Edge>) {
        match self.phase {
            Phase::Active => out.extend([Edge::Released, Edge::Cancelled]),
            Phase::Pending(_) => {}
            Phase::Idle | Phase::Dirty => return,
        }
        self.phase = Phase::Dirty;
    }
}

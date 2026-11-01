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

use super::LoneKey;

/// Clean hold time before `Pressed` is emitted.
pub const DEBOUNCE_MS: u64 = 80;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    KeyDown,
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

pub struct LoneKeyMachine {
    key: LoneKey,
    phase: Phase,
}

impl LoneKeyMachine {
    pub fn new(key: LoneKey) -> Self {
        Self {
            key,
            phase: Phase::Idle,
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
        let mut out = self.tick(now);
        let own = keycode == self.key.keycode;
        match kind {
            Kind::TapDisabled => {
                // Events were lost, so we can't know the key is still down.
                if self.phase == Phase::Active {
                    out.extend([Edge::Released, Edge::Cancelled]);
                }
                self.phase = Phase::Idle;
            }
            Kind::MouseDown => self.make_dirty(&mut out),
            Kind::KeyDown if own && !self.key.is_modifier() => self.press(flags, now),
            Kind::KeyDown => self.make_dirty(&mut out),
            Kind::KeyUp if own && !self.key.is_modifier() => self.release(&mut out),
            Kind::KeyUp => {}
            Kind::FlagsChanged if own && self.key.is_modifier() => {
                if flags & self.key.device_mask != 0 {
                    self.press(flags, now);
                } else {
                    self.release(&mut out);
                }
            }
            Kind::FlagsChanged => {
                if self.key.other_modifiers(flags) != 0 {
                    self.make_dirty(&mut out);
                }
            }
        }
        out
    }

    /// Our key went down. Repeats while already down are ignored.
    fn press(&mut self, flags: u64, now: u64) {
        if self.phase != Phase::Idle {
            return;
        }
        self.phase = if self.key.other_modifiers(flags) != 0 {
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

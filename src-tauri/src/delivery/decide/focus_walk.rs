//! Bounded search of the frontmost app's focused window for the element with
//! AXFocused=true, used when AXFocusedUIElement has no value (-25212) on both
//! the system-wide and the application element (ChatGPT desktop, Electron).
//! Fail closed: the hit must be owned by the frontmost pid, be an insertable
//! role, and never be secure. Pure; the macOS adapter supplies the tree.

use super::{classify_role, effective_role};

pub const WALK_MAX_DEPTH: usize = 24;
pub const WALK_MAX_NODES: usize = 600;
pub const WALK_MAX_MS: u64 = 120;

/// AX facts the walk needs; `Node` owns its AX reference (drop releases).
pub trait AxTree {
    type Node;
    fn children(&mut self, node: &Self::Node) -> Vec<Self::Node>;
    fn is_focused(&mut self, node: &Self::Node) -> bool;
    fn role(&mut self, node: &Self::Node) -> Option<String>;
    fn subrole(&mut self, node: &Self::Node) -> Option<String>;
    fn pid(&mut self, node: &Self::Node) -> Option<i32>;
    fn elapsed_ms(&self) -> u64;
}

#[derive(Debug, PartialEq, Eq)]
pub enum WalkOutcome<N> {
    Found(N),
    /// A focused secure field: refuse, never insert.
    Secure,
    /// A focused element owned by another process: refuse.
    PidMismatch,
    NotFound {
        visited: usize,
    },
    Budget {
        visited: usize,
    },
}

impl<N> WalkOutcome<N> {
    /// Short diagnostic for the HUD (no field text, roles only).
    pub fn describe(&self) -> String {
        match self {
            Self::Found(_) => "found".into(),
            Self::Secure => "focused secure field (refused)".into(),
            Self::PidMismatch => "focused element not owned by frontmost app".into(),
            Self::NotFound { visited } => format!("no focused field in {visited} nodes"),
            Self::Budget { visited } => format!("budget exhausted after {visited} nodes"),
        }
    }
}

/// Breadth-first from `root` (the focused/main window). A focused non-field
/// (e.g. AXWebArea) is not a hit; the search continues beneath it.
pub fn find_focused<T: AxTree>(tree: &mut T, root: T::Node, front: i32) -> WalkOutcome<T::Node> {
    let mut queue = std::collections::VecDeque::from([(root, 0usize)]);
    let mut visited = 0;
    while let Some((node, depth)) = queue.pop_front() {
        if visited >= WALK_MAX_NODES || tree.elapsed_ms() > WALK_MAX_MS {
            return WalkOutcome::Budget { visited };
        }
        visited += 1;
        if tree.is_focused(&node) {
            if tree.pid(&node) != Some(front) {
                return WalkOutcome::PidMismatch;
            }
            let role = tree.role(&node).unwrap_or_default();
            let subrole = tree.subrole(&node);
            match classify_role(effective_role(&role, subrole.as_deref())) {
                ("secure", ..) => return WalkOutcome::Secure,
                (_, true, _) => return WalkOutcome::Found(node),
                _ => {}
            }
        }
        if depth < WALK_MAX_DEPTH {
            for child in tree.children(&node) {
                queue.push_back((child, depth + 1));
            }
        }
    }
    WalkOutcome::NotFound { visited }
}

#[cfg(test)]
#[path = "focus_walk_tests.rs"]
mod tests;

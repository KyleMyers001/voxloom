//! Unit tests for the capture coordinator, moved verbatim from the
//! former inline `mod tests` in `coordinator.rs`.

use super::*;
use crate::capture::buffer::{MAX_FRAMES, TARGET_RATE};
use std::sync::{Arc, Mutex};

mod support;
use support::*;

mod auto_stop_and_events;
mod capture_loop;
mod capture_loop_flush;
mod devices;
mod lifecycle;
mod permission_status;
mod stop_cancel;
mod timing;

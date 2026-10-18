//! Shared fakes, virtual runtimes and helpers for coordinator tests.

mod backends;
mod helpers;
mod runtimes;
mod stream_fakes;

pub(crate) use backends::*;
pub(crate) use helpers::*;
pub(crate) use runtimes::*;
pub(crate) use stream_fakes::*;

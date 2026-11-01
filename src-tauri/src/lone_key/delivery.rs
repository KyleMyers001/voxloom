//! Edge delivery away from the tap callback (BUS-46 slice 3).
//!
//! The CGEventTap callback only steps the state machine and queues edges here.
//! A delivery thread runs the sink, so the sink can never run inside the
//! callback: it cannot re-enter the tap, and `arm` / `disarm` (main thread
//! only) refuse to run from it. Each armed listener gets a generation; a
//! queued edge or wake-up from an earlier listener sees it is stale and is
//! dropped, whatever the allocator did with the old context's address.

use super::machine::Edge;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;

/// Receives each edge on the delivery thread.
pub type Sink = Box<dyn Fn(Edge) + Send + 'static>;

/// Which listener is current. Every arm and disarm moves it on.
#[derive(Clone, Default)]
pub struct Generations(Arc<AtomicU64>);

impl Generations {
    /// Start a new generation, retiring every earlier one. Returns its id.
    pub fn advance(&self) -> u64 {
        self.0.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn is_current(&self, generation: u64) -> bool {
        self.0.load(Ordering::SeqCst) == generation
    }
}

pub struct Delivery {
    queue: mpsc::Sender<Edge>,
}

impl Delivery {
    /// Run `sink` on its own thread for edges of `generation`. The thread
    /// ends when the `Delivery` is dropped or the generation is retired.
    pub fn spawn(live: Generations, generation: u64, sink: Sink) -> Result<Self, String> {
        let (queue, edges) = mpsc::channel();
        thread::Builder::new()
            .name("lone-key-edges".into())
            .spawn(move || {
                for edge in edges {
                    if !live.is_current(generation) {
                        break;
                    }
                    sink(edge);
                }
            })
            .map_err(|e| format!("Could not start the shortcut key monitor: {e}"))?;
        Ok(Self { queue })
    }

    /// Queue edges in order; never runs the sink on the calling thread.
    pub fn send(&self, edges: Vec<Edge>) {
        for edge in edges {
            // The thread only ends once retired, when edges are moot.
            let _ = self.queue.send(edge);
        }
    }
}

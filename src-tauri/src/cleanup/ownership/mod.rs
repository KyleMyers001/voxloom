//! Main-renderer generations and request ownership. Lock order is registry ->
//! supervisor; model I/O, descriptor drop, hashing and process waits occur outside
//! the registry lock. Running tasks, never this registry, own active descriptors.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::model_store::ModelLease;
use super::supervisor::WorkerSupervisor;
use super::CleanupCommandError;

mod admission;
mod run;

#[cfg(test)]
mod tests;

type Result<T> = std::result::Result<T, CleanupCommandError>;

#[derive(Clone, Hash, PartialEq, Eq)]
struct RequestKey {
    owner: u64,
    id: String,
}

enum Entry {
    Acquiring(u64),
    Pending(u64, ModelLease),
    Running(u64),
}

#[derive(Default)]
struct RegistryInner {
    owner: Option<u64>,
    next_owner: u64,
    next_ticket: u64,
    entries: HashMap<RequestKey, Entry>,
}

#[derive(Clone)]
pub(super) struct RequestRegistry {
    inner: Arc<Mutex<RegistryInner>>,
    supervisor: Arc<WorkerSupervisor>,
}

pub(super) struct Retirement {
    supervisor: Arc<WorkerSupervisor>,
    running: Vec<String>,
}

impl Retirement {
    /// Run on a blocking task, never the native page-load callback thread.
    pub fn finish(self) {
        for id in self.running {
            self.supervisor.cancel(&id);
            self.supervisor.wait_for_settlement(&id);
            self.supervisor.release(&id);
        }
    }
}

fn authorized(inner: &RegistryInner, owner: u64) -> Result<()> {
    if inner.owner != Some(owner) {
        return Err(CleanupCommandError::cancelled());
    }
    Ok(())
}

fn worker_id(key: &RequestKey, ticket: u64) -> String {
    // Native tickets, not renderer-provided IDs, also prevent ABA races when a
    // canceled acquire finishes after the same client ID was re-reserved.
    format!("{}:{ticket}", key.owner)
}

impl RequestRegistry {
    pub fn new(supervisor: Arc<WorkerSupervisor>) -> Self {
        Self {
            inner: Arc::default(),
            supervisor,
        }
    }

    pub fn open_session(&self) -> (u64, Retirement) {
        let mut inner = self.inner.lock().unwrap();
        let (leases, running) = self.retire_locked(&mut inner);
        inner.next_owner += 1;
        let owner = inner.next_owner;
        inner.owner = Some(owner);
        drop(inner);
        drop(leases);
        (
            owner,
            Retirement {
                supervisor: Arc::clone(&self.supervisor),
                running,
            },
        )
    }

    pub fn retire(&self, owner: Option<u64>) -> Retirement {
        let mut inner = self.inner.lock().unwrap();
        let (leases, running) = if owner.is_none() || inner.owner == owner {
            self.retire_locked(&mut inner)
        } else {
            (Vec::new(), Vec::new())
        };
        drop(inner);
        drop(leases);
        Retirement {
            supervisor: Arc::clone(&self.supervisor),
            running,
        }
    }

    fn retire_locked(&self, inner: &mut RegistryInner) -> (Vec<ModelLease>, Vec<String>) {
        let owner = inner.owner.take();
        let keys: Vec<_> = inner
            .entries
            .keys()
            .filter(|key| Some(key.owner) == owner)
            .cloned()
            .collect();
        let mut leases = Vec::new();
        let mut running = Vec::new();
        for key in keys {
            match inner.entries.get(&key) {
                Some(Entry::Running(ticket)) => {
                    let id = worker_id(&key, *ticket);
                    self.supervisor.mark_cancelled(&id);
                    running.push(id);
                }
                _ => {
                    if let Some(Entry::Pending(_, lease)) = inner.entries.remove(&key) {
                        leases.push(lease);
                    }
                }
            }
        }
        (leases, running)
    }
}

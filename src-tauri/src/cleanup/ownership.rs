//! Main-renderer generations and request ownership. Lock order is registry ->
//! supervisor; model I/O, descriptor drop, hashing and process waits occur outside
//! the registry lock. Running tasks, never this registry, own active descriptors.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::model_store::{ModelLease, MODEL_ID};
use super::supervisor::{WorkerReservation, WorkerSupervisor};
use super::CleanupCommandError;

type Result<T> = std::result::Result<T, CleanupCommandError>;

#[derive(Clone, Hash, PartialEq, Eq)]
struct RequestKey {
    owner: u64,
    id: String,
}

pub(super) struct Acquisition {
    key: RequestKey,
    ticket: u64,
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

    fn retire_locked(
        &self,
        inner: &mut RegistryInner,
    ) -> (Vec<ModelLease>, Vec<String>) {
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
                    if let Some(Entry::Pending(_, lease)) =
                        inner.entries.remove(&key)
                    {
                        leases.push(lease);
                    }
                }
            }
        }
        (leases, running)
    }

    pub fn begin_acquire(&self, owner: u64, id: &str) -> Result<Acquisition> {
        let mut inner = self.inner.lock().unwrap();
        authorized(&inner, owner)?;
        let key = RequestKey {
            owner,
            id: id.to_owned(),
        };
        if inner.entries.contains_key(&key) {
            return Err(CleanupCommandError::runtime(
                "cleanup request already reserved",
            ));
        }
        // Includes tasks still settling from a retired generation.
        if inner.entries.len() >= 2 {
            return Err(CleanupCommandError::runtime(
                "cleanup admission is full",
            ));
        }
        inner.next_ticket += 1;
        let ticket = inner.next_ticket;
        inner.entries.insert(key.clone(), Entry::Acquiring(ticket));
        Ok(Acquisition { key, ticket })
    }

    pub fn complete_acquire(
        &self,
        token: Acquisition,
        lease: std::result::Result<ModelLease, String>,
    ) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        if inner.owner != Some(token.key.owner)
            || !matches!(
                inner.entries.get(&token.key),
                Some(Entry::Acquiring(ticket)) if *ticket == token.ticket
            )
        {
            // Explicitly unlock before dropping a stale successful lease.
            drop(inner);
            drop(lease);
            return Err(CleanupCommandError::cancelled());
        }
        match lease {
            Ok(lease) => {
                inner
                    .entries
                    .insert(token.key, Entry::Pending(token.ticket, lease));
                Ok(())
            }
            Err(error) => {
                inner.entries.remove(&token.key);
                Err(CleanupCommandError::model(error))
            }
        }
    }

    pub fn start_run(
        &self,
        owner: u64,
        id: &str,
        model_id: &str,
    ) -> Result<OwnedRun> {
        let mut inner = self.inner.lock().unwrap();
        authorized(&inner, owner)?;
        if model_id != MODEL_ID {
            return Err(CleanupCommandError::model(
                "cleanup model lease does not match request".into(),
            ));
        }
        let key = RequestKey {
            owner,
            id: id.to_owned(),
        };
        let Some(Entry::Pending(ticket, _)) = inner.entries.get(&key) else {
            return Err(CleanupCommandError::model(
                "cleanup model lease is unavailable".into(),
            ));
        };
        let ticket = *ticket;
        // Short, atomic reservation under the registry lock: retirement cannot
        // slip between transfer to running and supervisor admission.
        let permit = self
            .supervisor
            .reserve(worker_id(&key, ticket))
            .map_err(CleanupCommandError::from)?;
        let Some(Entry::Pending(_, lease)) = inner.entries.remove(&key) else {
            unreachable!()
        };
        inner.entries.insert(key.clone(), Entry::Running(ticket));
        Ok(OwnedRun {
            inner: Arc::clone(&self.inner),
            key,
            ticket,
            lease: Some(lease),
            permit: Some(permit),
        })
    }

    pub fn settle(&self, owner: u64, id: &str) -> Result<bool> {
        let mut inner = self.inner.lock().unwrap();
        authorized(&inner, owner)?;
        let key = RequestKey {
            owner,
            id: id.to_owned(),
        };
        if let Some(Entry::Running(ticket)) = inner.entries.get(&key) {
            let id = worker_id(&key, *ticket);
            self.supervisor.mark_cancelled(&id);
            drop(inner);
            self.supervisor.cancel(&id);
            self.supervisor.wait_for_settlement(&id);
            self.supervisor.release(&id);
            return Ok(true);
        }
        let removed = inner.entries.remove(&key);
        drop(inner);
        let existed = removed.is_some();
        drop(removed);
        Ok(existed)
    }
}

pub(super) struct OwnedRun {
    inner: Arc<Mutex<RegistryInner>>,
    key: RequestKey,
    ticket: u64,
    lease: Option<ModelLease>,
    permit: Option<WorkerReservation>,
}

impl OwnedRun {
    pub fn cancelled(&self) -> bool {
        self.permit.as_ref().unwrap().cancelled()
    }

    pub fn run(mut self, prompt: String) -> Result<String> {
        if self.cancelled() {
            return Err(CleanupCommandError::cancelled());
        }
        let verification = self.lease.as_mut().unwrap().verify();
        if self.cancelled() {
            return Err(CleanupCommandError::cancelled());
        }
        verification.map_err(CleanupCommandError::model)?;
        self.permit
            .as_mut()
            .unwrap()
            .run(&self.lease.as_ref().unwrap().file, prompt)
            .map_err(CleanupCommandError::from)
    }
}

impl Drop for OwnedRun {
    fn drop(&mut self) {
        // Keep import and admission excluded until the process is reaped. Then
        // release the descriptor before notifying cancellation waiters.
        self.permit.as_ref().unwrap().finish();
        drop(self.lease.take());
        let mut inner = self.inner.lock().unwrap();
        if matches!(inner.entries.get(&self.key), Some(Entry::Running(ticket)) if *ticket == self.ticket)
        {
            inner.entries.remove(&self.key);
        }
        drop(inner);
        drop(self.permit.take());
    }
}

#[cfg(test)]
#[path = "ownership_tests.rs"]
mod tests;

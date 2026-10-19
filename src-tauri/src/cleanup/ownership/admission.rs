//! Admission: acquire a model lease for a request, start its run, or settle it.

use std::sync::Arc;

use super::run::OwnedRun;
use super::{authorized, worker_id, Entry, RequestKey, RequestRegistry, Result};
use crate::cleanup::model_store::{ModelLease, MODEL_ID};
use crate::cleanup::CleanupCommandError;

pub(in crate::cleanup) struct Acquisition {
    key: RequestKey,
    ticket: u64,
}

impl RequestRegistry {
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
            return Err(CleanupCommandError::runtime("cleanup admission is full"));
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

    pub fn start_run(&self, owner: u64, id: &str, model_id: &str) -> Result<OwnedRun> {
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

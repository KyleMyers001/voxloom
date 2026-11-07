//! Turbo-only, in-process admission: at most two live requests, one executing
//! context. Prepare never loads/prewarms. Only the blocking transcription pool
//! waits. Cancellation is cooperative; synchronous model loading is not
//! interruptible, and retains the executing reservation until it actually exits.
use super::error::SttErrorDto;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
};

#[cfg(test)]
#[path = "turbo_tests.rs"]
mod tests;

pub const MODEL_ID: &str = "whisper-large-v3-turbo";
const MAX_RECENT_IDS: usize = 4096;
struct Job {
    id: String,
    epoch: u64,
    model: String,
    cancel: Arc<AtomicBool>,
    claimed: AtomicBool,
}
#[derive(Default)]
struct Registry {
    epoch: u64,
    recent: VecDeque<(String, bool)>,
    jobs: HashMap<String, Arc<Job>>,
    active: Option<Arc<Job>>,
}
impl Registry {
    fn remember(&mut self, id: &str, cancelled: bool) {
        if let Some((_, flag)) = self.recent.iter_mut().find(|(old, _)| old == id) {
            *flag |= cancelled;
        } else {
            if self.recent.len() == MAX_RECENT_IDS {
                self.recent.pop_front();
            }
            self.recent.push_back((id.into(), cancelled));
        }
    }
    fn terminal(&self, id: &str) -> Option<SttErrorDto> {
        self.recent
            .iter()
            .find(|(old, _)| old == id)
            .map(|(_, flag)| {
                if *flag {
                    cancelled()
                } else {
                    invalid("Turbo request is single-use")
                }
            })
    }
}
#[derive(Default)]
struct Inner {
    registry: Mutex<Registry>,
    changed: Condvar,
}
#[derive(Clone, Default)]
pub struct TurboRuntime(Arc<Inner>);
fn cancelled() -> SttErrorDto {
    SttErrorDto::new("cancelled", "Turbo request cancelled or renderer retired")
}
fn invalid(message: &str) -> SttErrorDto {
    SttErrorDto::new("transcribe-failed", message)
}
fn validate_id(id: &str) -> Result<(), SttErrorDto> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.:".contains(&c))
    {
        Err(invalid("Invalid Turbo request ID"))
    } else {
        Ok(())
    }
}
impl TurboRuntime {
    pub(super) fn check_model_claim(&self, id: &str, model: &str) -> Result<(), SttErrorDto> {
        let reg = self.0.registry.lock().unwrap();
        if reg.jobs.get(id).is_some_and(|job| job.model != model) {
            Err(invalid("Request model is immutable"))
        } else {
            Ok(())
        }
    }
    pub fn epoch(&self) -> u64 {
        self.0.registry.lock().unwrap().epoch
    }
    pub fn retire_main(&self, label: &str) {
        if label != "main" {
            return;
        }
        let mut reg = self.0.registry.lock().unwrap();
        reg.epoch += 1;
        let ids: Vec<_> = reg.jobs.keys().cloned().collect();
        for id in ids {
            let job = reg.jobs.get(&id).unwrap().clone();
            job.cancel.store(true, Ordering::SeqCst);
            if !reg
                .active
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, &job))
            {
                reg.jobs.remove(&id);
            }
            reg.remember(&id, true);
        }
        self.0.changed.notify_all();
    }
    /// The runner must drop its model/state before returning a lightweight DTO.
    /// RAII retains the reservation through errors and unwinding as well.
    pub(super) fn run<T>(
        &self,
        epoch: u64,
        id: &str,
        model: &str,
        runner: impl FnOnce(Arc<AtomicBool>) -> Result<T, SttErrorDto>,
    ) -> Result<T, SttErrorDto> {
        validate_id(id)?;
        let job = {
            let mut reg = self.0.registry.lock().unwrap();
            if reg.epoch != epoch {
                return Err(cancelled());
            }
            if let Some(error) = reg.terminal(id) {
                return Err(error);
            }
            let job = reg
                .jobs
                .get(id)
                .cloned()
                .ok_or_else(|| invalid("Turbo preparation is required"))?;
            if job.model != model {
                return Err(invalid("Request model is immutable"));
            }
            if job.claimed.swap(true, Ordering::SeqCst) {
                return Err(invalid("Turbo request is single-use"));
            }
            self.0.changed.notify_all();
            while reg.active.is_some() && !job.cancel.load(Ordering::SeqCst) {
                reg = self.0.changed.wait(reg).unwrap();
            }
            if job.cancel.load(Ordering::SeqCst) {
                return Err(cancelled());
            }
            reg.active = Some(job.clone());
            job
        };
        let reservation = Reservation {
            runtime: self.clone(),
            job,
        };
        let result = runner(reservation.job.cancel.clone());
        // Linearize final cancellation versus completion under the same lock.
        let mut reg = self.0.registry.lock().unwrap();
        let was_cancelled = reservation.job.cancel.load(Ordering::SeqCst);
        reservation.finish(&mut reg);
        drop(reg);
        if was_cancelled {
            Err(cancelled())
        } else {
            result
        }
    }
    pub fn prepare(&self, epoch: u64, id: &str, model: &str) -> Result<(), SttErrorDto> {
        validate_id(id)?;
        let mut reg = self.0.registry.lock().unwrap();
        if reg.epoch != epoch {
            return Err(cancelled());
        }
        if let Some(error) = reg.terminal(id) {
            return Err(error);
        }
        if let Some(existing) = reg.jobs.get(id) {
            if existing.cancel.load(Ordering::SeqCst) {
                return Err(cancelled());
            }
            return if existing.model == model {
                Ok(())
            } else {
                Err(invalid("Request model is immutable"))
            };
        }
        if reg.jobs.len() >= 2 {
            return Err(SttErrorDto::new("busy", "Turbo has two admitted requests"));
        }
        reg.jobs.insert(
            id.into(),
            Arc::new(Job {
                id: id.into(),
                epoch,
                model: model.into(),
                cancel: Arc::new(AtomicBool::new(false)),
                claimed: AtomicBool::new(false),
            }),
        );
        Ok(())
    }
    pub fn cancel(&self, epoch: u64, id: &str) -> Result<bool, SttErrorDto> {
        validate_id(id)?;
        let mut reg = self.0.registry.lock().unwrap();
        if reg.epoch != epoch {
            return Ok(false);
        }
        if let Some(job) = reg.jobs.get(id).cloned() {
            if job.epoch != epoch {
                return Ok(false);
            }
            job.cancel.store(true, Ordering::SeqCst);
            if !reg
                .active
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, &job))
            {
                reg.jobs.remove(id);
            }
        }
        reg.remember(id, true);
        self.0.changed.notify_all();
        Ok(true)
    }
}
struct Reservation {
    runtime: TurboRuntime,
    job: Arc<Job>,
}
impl Reservation {
    fn finish(&self, reg: &mut Registry) {
        if reg
            .active
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, &self.job))
        {
            reg.active = None;
            if reg
                .jobs
                .get(&self.job.id)
                .is_some_and(|job| Arc::ptr_eq(job, &self.job))
            {
                reg.jobs.remove(&self.job.id);
            }
            reg.remember(&self.job.id, self.job.cancel.load(Ordering::SeqCst));
            self.runtime.0.changed.notify_all();
        }
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.finish(&mut self.runtime.0.registry.lock().unwrap());
    }
}

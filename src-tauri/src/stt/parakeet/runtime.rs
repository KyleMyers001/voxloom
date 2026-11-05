//! One fresh worker per admitted recording; one active, at most one FIFO pending.
//! Locks protect bookkeeping only. The runner owns/kills/reaps its exact child.
use super::{
    process::{check, Worker},
    protocol,
};
use crate::stt::{
    cleanup::DropReason, engine::TranscriptDto, error::SttErrorDto,
    filter_config::SpeechFilterConfig, gate::AudioStats,
};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};
type Output = Result<TranscriptDto, SttErrorDto>;
type Resolve = Box<dyn FnOnce() -> Result<PathBuf, SttErrorDto> + Send>;
// FIFO replay window, not a lifetime admission quota. Live jobs and the active
// runner reservation remain protected independently of terminal-ID eviction.
const MAX_RECENT_IDS: usize = 4096;
const MAX_RETAINED: usize = 64;
const AUDIO_WAIT: Duration = Duration::from_secs(150);
const LOAD: Duration = Duration::from_secs(90);
const INFERENCE: Duration = Duration::from_secs(120);
struct Job {
    id: String,
    model: String,
    version: String,
    deadline: Instant,
    cancel: AtomicBool,
    data: Mutex<JobData>,
    changed: Condvar,
}
#[derive(Default)]
struct JobData {
    pcm: Option<Vec<f32>>,
    claimed: bool,
    result: Option<Output>,
}
struct Work {
    job: Arc<Job>,
    resolve: Resolve,
}
enum TerminalState {
    Completed,
    Cancelled,
}
#[derive(Default)]
struct Registry {
    epoch: u64,
    active: Option<Arc<Job>>,
    pending: Option<Work>,
    jobs: HashMap<String, Arc<Job>>,
    recent: HashMap<String, TerminalState>,
    terminal_order: VecDeque<String>,
}
impl Registry {
    fn is_cancelled(&self, id: &str) -> bool {
        matches!(self.recent.get(id), Some(TerminalState::Cancelled))
            || self
                .active
                .as_ref()
                .is_some_and(|job| job.id == id && job.cancel.load(Ordering::SeqCst))
    }
    fn remember_terminal(&mut self, id: &str, state: TerminalState) {
        if let Some(retained) = self.recent.get_mut(id) {
            // Repeated release does not grow or refresh the FIFO window.
            if matches!(state, TerminalState::Cancelled) {
                *retained = state;
            }
            return;
        }
        if self.recent.len() == MAX_RECENT_IDS {
            if let Some(oldest) = self.terminal_order.pop_front() {
                self.recent.remove(&oldest);
            }
        }
        self.recent.insert(id.into(), state);
        self.terminal_order.push_back(id.into());
    }
}
struct Inner {
    path: PathBuf,
    audio_wait: Duration,
    registry: Mutex<Registry>,
}
#[derive(Clone)]
pub struct ParakeetRuntime {
    inner: Arc<Inner>,
}
fn cancelled() -> SttErrorDto {
    SttErrorDto::new(
        "cancelled",
        "Parakeet request cancelled or renderer retired",
    )
}
fn busy() -> SttErrorDto {
    SttErrorDto::new(
        "busy",
        "Parakeet has one active and one pending recording, or request capacity is full",
    )
}
fn validate_id(id: &str) -> Result<(), SttErrorDto> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.:".contains(&c))
    {
        return Err(SttErrorDto::new(
            "transcribe-failed",
            "Invalid Parakeet request ID",
        ));
    }
    Ok(())
}
impl ParakeetRuntime {
    pub fn new(path: PathBuf) -> Self {
        Self {
            inner: Arc::new(Inner {
                path,
                audio_wait: AUDIO_WAIT,
                registry: Mutex::new(Registry::default()),
            }),
        }
    }
    #[cfg(test)]
    fn with_short_audio_wait(path: PathBuf) -> Self {
        Self {
            inner: Arc::new(Inner {
                path,
                audio_wait: Duration::from_millis(300),
                registry: Mutex::new(Registry::default()),
            }),
        }
    }
    pub fn epoch(&self) -> u64 {
        self.inner.registry.lock().unwrap().epoch
    }
    pub fn prepare(
        &self,
        epoch: u64,
        id: &str,
        model: &str,
        version: &str,
        resolve: impl FnOnce() -> Result<PathBuf, SttErrorDto> + Send + 'static,
    ) -> Result<(), SttErrorDto> {
        validate_id(id)?;
        let work = {
            let mut reg = self.inner.registry.lock().unwrap();
            if reg.epoch != epoch || reg.is_cancelled(id) {
                return Err(cancelled());
            }
            if let Some(job) = reg.jobs.get(id) {
                return if job.model == model {
                    Ok(())
                } else {
                    Err(SttErrorDto::new(
                        "transcribe-failed",
                        "Request model is immutable",
                    ))
                };
            }
            if reg.recent.contains_key(id) || reg.active.as_ref().is_some_and(|job| job.id == id) {
                return Err(SttErrorDto::new(
                    "transcribe-failed",
                    "Parakeet request is single-use",
                ));
            }
            if reg.pending.is_some() || reg.jobs.len() >= MAX_RETAINED {
                return Err(busy());
            }
            let job = Arc::new(Job {
                id: id.into(),
                model: model.into(),
                version: version.into(),
                deadline: Instant::now() + self.inner.audio_wait,
                cancel: AtomicBool::new(false),
                data: Mutex::new(JobData::default()),
                changed: Condvar::new(),
            });
            reg.jobs.insert(id.into(), job.clone());
            let work = Work {
                job: job.clone(),
                resolve: Box::new(resolve),
            };
            if reg.active.is_some() {
                reg.pending = Some(work);
                None
            } else {
                reg.active = Some(job);
                Some(work)
            }
        };
        if let Some(work) = work {
            let inner = self.inner.clone();
            std::thread::spawn(move || run_queue(inner, work));
        }
        Ok(())
    }
    pub fn transcribe(
        &self,
        epoch: u64,
        id: &str,
        model: &str,
        pcm: Vec<f32>,
        rate: u32,
        cfg: &SpeechFilterConfig,
    ) -> Output {
        validate_id(id)?;
        let job = {
            let reg = self.inner.registry.lock().unwrap();
            if reg.epoch != epoch || reg.is_cancelled(id) {
                return Err(cancelled());
            }
            reg.jobs.get(id).cloned().ok_or_else(|| {
                SttErrorDto::new("transcribe-failed", "Parakeet preparation is required")
            })?
        };
        if job.model != model {
            self.cancel(epoch, id)?;
            return Err(SttErrorDto::new(
                "transcribe-failed",
                "Request model is immutable",
            ));
        }
        if let Err(error) = protocol::validate_pcm(&pcm, rate) {
            self.cancel(epoch, id)?;
            return Err(error);
        }
        let silent = AudioStats::measure(&pcm).is_silent(cfg);
        {
            let mut data = job.data.lock().unwrap();
            if data.claimed {
                return Err(SttErrorDto::new(
                    "transcribe-failed",
                    "Parakeet request is single-use",
                ));
            }
            data.claimed = true;
            if !silent {
                data.pcm = Some(pcm);
                job.changed.notify_all();
            }
        }
        if silent {
            self.cancel(epoch, id)?;
            return Ok(TranscriptDto {
                text: String::new(),
                raw_text: String::new(),
                language: None,
                dropped: Some(DropReason::SilentAudio),
            });
        }
        let out = {
            let mut data = job.data.lock().unwrap();
            loop {
                if job.cancel.load(Ordering::SeqCst) {
                    break Err(cancelled());
                }
                if let Some(out) = data.result.take() {
                    break out;
                }
                data = job
                    .changed
                    .wait_timeout(data, Duration::from_millis(20))
                    .unwrap()
                    .0;
            }
        };
        let mut reg = self.inner.registry.lock().unwrap();
        if reg.epoch != epoch || job.cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        if reg
            .jobs
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(current, &job))
        {
            reg.jobs.remove(id);
            reg.remember_terminal(id, TerminalState::Completed);
        }
        out
    }
    pub fn cancel(&self, epoch: u64, id: &str) -> Result<bool, SttErrorDto> {
        validate_id(id)?;
        let mut reg = self.inner.registry.lock().unwrap();
        if reg.epoch != epoch {
            return Err(cancelled());
        }
        reg.remember_terminal(id, TerminalState::Cancelled);
        let job = reg.jobs.remove(id);
        if let Some(job) = &job {
            job.cancel.store(true, Ordering::SeqCst);
            job.changed.notify_all();
        }
        if reg.pending.as_ref().is_some_and(|w| w.job.id == id) {
            reg.pending.take();
        }
        Ok(job.is_some())
    }
    pub fn retire_main(&self, label: &str) {
        if label != "main" {
            return;
        }
        let mut reg = self.inner.registry.lock().unwrap();
        reg.epoch = reg.epoch.wrapping_add(1);
        for job in reg.jobs.values() {
            job.cancel.store(true, Ordering::SeqCst);
            job.changed.notify_all();
        }
        // Active stays reserved until its runner has actually reaped the child.
        if let Some(job) = &reg.active {
            job.cancel.store(true, Ordering::SeqCst);
            job.changed.notify_all();
        }
        reg.pending.take();
        reg.jobs.clear();
        reg.recent.clear();
        reg.terminal_order.clear();
    }
    #[cfg(test)]
    fn idle(&self) -> bool {
        let reg = self.inner.registry.lock().unwrap();
        reg.active.is_none() && reg.pending.is_none()
    }
}
fn run_queue(inner: Arc<Inner>, mut work: Work) {
    loop {
        let job = work.job.clone();
        let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run(&inner.path, &job, work.resolve)
        }))
        .unwrap_or_else(|_| {
            Err(SttErrorDto::new(
                "transcribe-failed",
                "Parakeet background task failed",
            ))
        });
        {
            let mut data = job.data.lock().unwrap();
            data.pcm = None;
            data.result = Some(out);
            job.changed.notify_all();
        }
        let next = {
            let mut reg = inner.registry.lock().unwrap();
            // This exact runner, not a stale request's cleanup, advances the slot.
            if reg
                .active
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, &job))
            {
                reg.active = None;
            }
            let next = reg.pending.take();
            if let Some(w) = &next {
                reg.active = Some(w.job.clone());
            }
            next
        };
        match next {
            Some(next) => work = next,
            None => break,
        }
    }
}
fn run(path: &std::path::Path, job: &Job, resolve: Resolve) -> Output {
    check(&job.cancel, job.deadline)?;
    let dir = resolve()?;
    check(&job.cancel, job.deadline)?;
    let mut worker = Worker::load(
        path,
        &dir,
        &job.id,
        &job.version,
        &job.cancel,
        std::cmp::min(LOAD, job.deadline.saturating_duration_since(Instant::now())),
    )?;
    let pcm = {
        let mut data = job.data.lock().unwrap();
        loop {
            check(&job.cancel, job.deadline)?;
            if let Some(pcm) = data.pcm.take() {
                break pcm;
            }
            data = job
                .changed
                .wait_timeout(data, Duration::from_millis(20))
                .unwrap()
                .0;
        }
    };
    worker.transcribe(&job.id, &job.version, &pcm, &job.cancel, INFERENCE)
}
#[cfg(all(test, unix))]
#[path = "runtime_tests.rs"]
mod tests;

//! llama.cpp inference: load the GGUF from the given path, run the ChatML
//! prompt, decode greedily until end-of-generation or the token budget.
//! Model-agnostic across Qwen3 sizes; nothing here assumes one checkpoint.

use std::num::NonZeroU32;
use std::time::Instant;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::LlamaModel;
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::LlamaToken;
use llama_cpp_2::{send_logs_to_tracing, LogOptions};

use crate::error::WorkerError;
use crate::sizing::{self, Sizing};
use crate::template::{suffix, PREFIX};
use crate::{output, user_tokens};

/// Prompt tokens fed per decode call.
const BATCH: usize = 512;

/// One model run, as the request and prewarm paths call it.
pub trait Generate {
    /// Run `prompt`, with at most `cap` reply tokens, until `deadline`. Stop
    /// early with `WorkerError::preempted()` once `preempt` says so.
    fn generate(
        &self,
        prompt: &str,
        deadline: Option<Instant>,
        cap: usize,
        preempt: &mut dyn FnMut() -> bool,
    ) -> Result<String, WorkerError>;
}

/// The backend and the loaded model: loaded once per process.
/// Fields drop in order: the model before the backend it was loaded with.
pub struct Engine {
    model: LlamaModel,
    backend: LlamaBackend,
}

/// Load the model, then run one prompt (the one-request path).
pub fn generate(
    model_path: &str,
    prompt: &str,
    deadline: Option<Instant>,
) -> Result<String, WorkerError> {
    Engine::load(model_path)?.generate(prompt, deadline, usize::MAX, &mut || false)
}

impl Engine {
    pub fn load(model_path: &str) -> Result<Self, WorkerError> {
        // llama.cpp logs to stderr by default, including prompt-derived details.
        // Mutant W10 (`with_logs_enabled(true)`) is equivalent today: the logs
        // then go to `tracing`, and the worker installs no subscriber, so they
        // are dropped either way. Only removing this call reaches stderr, which
        // the contract tests catch. Keep it disabled in case a subscriber is
        // ever added (BUS-16 10555 L2).
        send_logs_to_tracing(LogOptions::default().with_logs_enabled(false));
        // load_from_file debug-asserts the path exists; answer a closed fd 3 first.
        if !std::path::Path::new(model_path).exists() {
            return Err(WorkerError::model("no cleanup model on fd 3"));
        }
        let backend =
            LlamaBackend::init().map_err(|_| WorkerError::runtime("backend init failed"))?;
        // Offload every layer when a GPU backend exists (Metal); ignored on CPU.
        let params = LlamaModelParams::default().with_n_gpu_layers(u32::MAX);
        let model = LlamaModel::load_from_file(&backend, model_path, &params)
            .map_err(|_| WorkerError::model("could not load the cleanup model"))?;
        Ok(Self { model, backend })
    }
}

impl Generate for Engine {
    fn generate(
        &self,
        prompt: &str,
        deadline: Option<Instant>,
        cap: usize,
        preempt: &mut dyn FnMut() -> bool,
    ) -> Result<String, WorkerError> {
        let model = &self.model;
        let tokens = chat_tokens(model, prompt);
        let sizing = sizing::size(tokens.len(), model.n_ctx_train())?;
        let threads = std::thread::available_parallelism().map_or(4, |n| n.get() as i32);
        let mut ctx = model
            .new_context(&self.backend, context_params(&sizing, threads))
            .map_err(|_| WorkerError::runtime("could not create a model context"))?;

        let mut batch = LlamaBatch::new(BATCH, 1);
        let mut position = 0_i32;
        for chunk in tokens.chunks(BATCH) {
            if preempt() {
                return Err(WorkerError::preempted());
            }
            batch.clear();
            for (index, token) in chunk.iter().enumerate() {
                let last = position as usize + index + 1 == tokens.len();
                batch
                    .add(*token, position + index as i32, &[0], last)
                    .map_err(|_| WorkerError::runtime("prompt batch failed"))?;
            }
            ctx.decode(&mut batch)
                .map_err(|_| WorkerError::runtime("prompt decode failed"))?;
            position += chunk.len() as i32;
        }

        let vocab = model.vocab();
        let mut sampler = LlamaSampler::greedy();
        // After load and prefill, so the cap reflects the time really left.
        let limit = crate::deadline::limit(sizing.budget.min(cap), deadline, Instant::now());
        let reply = output::collect(limit.tokens, || {
            if preempt() {
                return Err(WorkerError::preempted());
            }
            let token = sampler.sample(&ctx, batch.n_tokens() - 1);
            sampler.accept(token);
            if vocab.is_eog(token) {
                return Ok(None);
            }
            let piece = vocab.token_to_piece(token, false, None);
            batch.clear();
            batch
                .add(token, position, &[0], true)
                .map_err(|_| WorkerError::runtime("output batch failed"))?;
            position += 1;
            ctx.decode(&mut batch)
                .map_err(|_| WorkerError::runtime("output decode failed"))?;
            Ok(Some(piece))
        });
        reply.map_err(|error| limit.explain(error))
    }
}

/// The context exactly as `sizing` asks (QA 3c-2a Low-1: an off-by-one
/// here undoes Codex 4318723345 and no real-model test notices).
fn context_params(sizing: &Sizing, threads: i32) -> LlamaContextParams {
    LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(sizing.n_ctx))
        .with_n_batch(BATCH as u32)
        .with_n_threads(threads)
        .with_n_threads_batch(threads)
}

/// Template parts parse special tokens. The prompt does not, which keeps
/// CONTROL tokens such as "<|im_end|>" as plain text; USER_DEFINED ones
/// (`<think>`, `<tool_call>` …) are split apart by `user_tokens` first.
pub(crate) fn chat_tokens(model: &LlamaModel, prompt: &str) -> Vec<LlamaToken> {
    let vocab = model.vocab();
    let mut tokens = vocab.tokenize(PREFIX.as_bytes(), false, true);
    tokens.extend(user_tokens::tokenize(model, prompt));
    let template = model.chat_template(None).ok();
    let template = template
        .as_ref()
        .and_then(|template| template.to_str().ok());
    tokens.extend(vocab.tokenize(suffix(template).as_bytes(), false, true));
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_context_is_sized_exactly_as_sizing_says() {
        let sizing = sizing::size(160, 40_960).unwrap();
        let params = context_params(&sizing, 3);
        assert_eq!(params.n_ctx(), NonZeroU32::new(513));
        assert_eq!(params.n_batch(), 512);
        assert_eq!(params.n_threads(), 3);
        assert_eq!(params.n_threads_batch(), 3);
    }
}

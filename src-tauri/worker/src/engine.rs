//! llama.cpp inference: load the GGUF from the given path, run the ChatML
//! prompt, decode greedily until end-of-generation or the token budget.
//! Model-agnostic across Qwen3 sizes; nothing here assumes one checkpoint.

use std::num::NonZeroU32;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::LlamaModel;
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::LlamaToken;
use llama_cpp_2::{send_logs_to_tracing, LogOptions};

use crate::error::WorkerError;
use crate::template::{suffix, PREFIX};
use crate::{output, sizing, user_tokens};

/// Prompt tokens fed per decode call.
const BATCH: usize = 512;

pub fn generate(model_path: &str, prompt: &str) -> Result<String, WorkerError> {
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
    let backend = LlamaBackend::init().map_err(|_| WorkerError::runtime("backend init failed"))?;
    // Offload every layer when a GPU backend exists (Metal); ignored on CPU.
    let params = LlamaModelParams::default().with_n_gpu_layers(u32::MAX);
    let model = LlamaModel::load_from_file(&backend, model_path, &params)
        .map_err(|_| WorkerError::model("could not load the cleanup model"))?;

    let tokens = chat_tokens(&model, prompt);
    let sizing = sizing::size(tokens.len(), model.n_ctx_train())?;
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get() as i32);
    let ctx_params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(sizing.n_ctx))
        .with_n_batch(BATCH as u32)
        .with_n_threads(threads)
        .with_n_threads_batch(threads);
    let mut ctx = model
        .new_context(&backend, ctx_params)
        .map_err(|_| WorkerError::runtime("could not create a model context"))?;

    let mut batch = LlamaBatch::new(BATCH, 1);
    let mut position = 0_i32;
    for chunk in tokens.chunks(BATCH) {
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
    output::collect(sizing.budget, || {
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
    })
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

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
use crate::template::{max_new_tokens, PREFIX, SUFFIX};

/// Prompt tokens fed per decode call.
const BATCH: usize = 512;
/// Matches the supervisor's output cap (supervisor/response.rs).
const MAX_OUTPUT_BYTES: usize = 32_000;

pub fn generate(model_path: &str, prompt: &str) -> Result<String, WorkerError> {
    // llama.cpp logs to stderr by default, including prompt-derived details.
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
    let budget = max_new_tokens(tokens.len());
    let needed = tokens.len().saturating_add(budget);
    if needed > model.n_ctx_train() as usize {
        return Err(WorkerError::overflow(
            "prompt too long for the model context",
        ));
    }
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get() as i32);
    let ctx_params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(needed as u32))
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
    let mut output = Vec::new();
    for _ in 0..budget {
        let token = sampler.sample(&ctx, batch.n_tokens() - 1);
        sampler.accept(token);
        if vocab.is_eog(token) {
            return finish(output);
        }
        output.extend(vocab.token_to_piece(token, false, None));
        if output.len() > MAX_OUTPUT_BYTES {
            return Err(WorkerError::output("cleanup output too long"));
        }
        batch.clear();
        batch
            .add(token, position, &[0], true)
            .map_err(|_| WorkerError::runtime("output batch failed"))?;
        position += 1;
        ctx.decode(&mut batch)
            .map_err(|_| WorkerError::runtime("output decode failed"))?;
    }
    Err(WorkerError::output(
        "cleanup output reached the token limit",
    ))
}

/// Template parts parse special tokens; the prompt does not, so dictated
/// text such as "<|im_end|>" stays plain text and cannot end the turn.
fn chat_tokens(model: &LlamaModel, prompt: &str) -> Vec<LlamaToken> {
    let vocab = model.vocab();
    let mut tokens = vocab.tokenize(PREFIX.as_bytes(), false, true);
    tokens.extend(vocab.tokenize(prompt.as_bytes(), false, false));
    tokens.extend(vocab.tokenize(SUFFIX.as_bytes(), false, true));
    tokens
}

fn finish(output: Vec<u8>) -> Result<String, WorkerError> {
    let text = String::from_utf8(output)
        .map_err(|_| WorkerError::output("cleanup output is not UTF-8"))?;
    let text = text.trim();
    if text.is_empty() {
        return Err(WorkerError::output("cleanup output is empty"));
    }
    Ok(text.to_owned())
}

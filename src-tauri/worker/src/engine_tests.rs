//! The call site of `context_params` (BUS-126, QA E5/E6 on #118): the
//! params unit test pins the function, these pin that every generation
//! builds its context from it. No model needed.

use super::*;

/// What `open_context` hands `new_context` for a prompt of `prompt_tokens`.
fn params_for(prompt_tokens: usize, threads: i32) -> (Sizing, LlamaContextParams) {
    let sizing = sizing::size(prompt_tokens, 40_960).unwrap();
    let mut seen = None;
    let context = open_context(&sizing, threads, |params| {
        seen = Some(params);
        Ok::<_, ()>("context")
    });
    assert_eq!(context, Ok("context"));
    (sizing, seen.expect("new_context was called"))
}

#[test]
fn new_context_gets_the_sized_params_for_short_and_long_prompts() {
    // 5 000 tokens is far past llama.cpp's default context (512), the
    // handed-over request case QA described for E6.
    for (prompt_tokens, threads) in [(8, 4), (160, 3), (5_000, 7)] {
        let (sizing, params) = params_for(prompt_tokens, threads);
        assert_eq!(params.n_ctx(), NonZeroU32::new(sizing.n_ctx));
        assert_eq!(params.n_batch(), BATCH as u32);
        assert_eq!(params.n_threads(), threads);
        assert_eq!(params.n_threads_batch(), threads);
    }
    assert!(params_for(5_000, 7).1.n_ctx() > NonZeroU32::new(512));
}

#[test]
fn a_refused_context_is_a_runtime_error() {
    let sizing = sizing::size(8, 40_960).unwrap();
    let refused = open_context(&sizing, 4, |_| Err::<(), _>("no memory"));
    assert_eq!(
        refused,
        Err(WorkerError::runtime("could not create a model context"))
    );
}

/// `generate` is the only path to a context, for the one-shot request, the
/// prewarm warm-up and the handed-over request alike, and it can't run
/// without a model. So pin its one call: if it stops going through
/// `open_context` (E1, E5 or E6 in QA's mutants), this fails.
#[test]
fn engine_generate_builds_its_only_context_through_open_context() {
    let source = include_str!("engine.rs");
    let production = &source[..source.find("#[cfg(test)]").unwrap()];
    assert_eq!(production.matches(".new_context(").count(), 1);
    assert_eq!(production.matches("open_context(").count(), 1);
    assert!(production.contains(
        "open_context(&sizing, threads, |params| {\n            model.new_context(&self.backend, params)\n        })"
    ));
}

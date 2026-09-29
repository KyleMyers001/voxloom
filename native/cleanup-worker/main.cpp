#include "chat.h"
#include "framing.hpp"
#include <nlohmann/json.hpp>
#include "llama.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

namespace {

constexpr uint32_t CONTEXT_TOKENS = 4096;
constexpr size_t OUTPUT_MAX_BYTES = 32'000;
constexpr int OUTPUT_MAX_TOKENS = 1024;
constexpr int OUTPUT_MIN_TOKENS = 64;

template <typename T>
using llama_ptr = std::unique_ptr<T, void (*)(T *)>;

std::vector<llama_token> tokenize(
    const llama_vocab * vocab,
    const std::string & prompt) {
    const int count = -llama_tokenize(
        vocab,
        prompt.data(),
        prompt.size(),
        nullptr,
        0,
        true,
        true);
    if (count <= 0) throw std::runtime_error("tokenize prompt size");
    std::vector<llama_token> tokens(static_cast<size_t>(count));
    const int written = llama_tokenize(
        vocab,
        prompt.data(),
        prompt.size(),
        tokens.data(),
        tokens.size(),
        true,
        true);
    if (written != count) throw std::runtime_error("tokenize prompt");
    return tokens;
}

std::string token_piece(
    const llama_vocab * vocab,
    llama_token token) {
    std::array<char, 256> stack{};
    int count = llama_token_to_piece(
        vocab,
        token,
        stack.data(),
        stack.size(),
        0,
        true);
    if (count >= 0) return {stack.data(), static_cast<size_t>(count)};
    std::vector<char> dynamic(static_cast<size_t>(-count));
    count = llama_token_to_piece(
        vocab,
        token,
        dynamic.data(),
        dynamic.size(),
        0,
        true);
    if (count < 0) throw std::runtime_error("decode token piece");
    return {dynamic.data(), static_cast<size_t>(count)};
}

std::string render_prompt(
    const llama_model * model,
    const std::string & content) {
    auto templates = common_chat_templates_init(model, "");
    if (!common_chat_templates_support_enable_thinking(templates.get())) {
        throw std::runtime_error(
            "model template does not support enable_thinking");
    }
    common_chat_templates_inputs inputs;
    inputs.enable_thinking = false;
    inputs.messages = {{"user", content}};
    return common_chat_templates_apply(templates.get(), inputs).prompt;
}

std::string generate(
    const std::string & model_path,
    const std::string & content) {
    ggml_backend_load_all();
    auto model_params = llama_model_default_params();
    model_params.n_gpu_layers = 99;
    llama_ptr<llama_model> model(
        llama_model_load_from_file(model_path.c_str(), model_params),
        llama_model_free);
    if (!model) throw std::runtime_error("load model");

    const llama_vocab * vocab = llama_model_get_vocab(model.get());
    const std::string prompt = render_prompt(model.get(), content);
    auto tokens = tokenize(vocab, prompt);
    const int available =
        static_cast<int>(CONTEXT_TOKENS) - static_cast<int>(tokens.size());
    const int output_tokens = std::min(OUTPUT_MAX_TOKENS, available);
    if (output_tokens < OUTPUT_MIN_TOKENS) {
        throw std::runtime_error("context-overflow");
    }

    auto context_params = llama_context_default_params();
    context_params.n_batch = std::min<uint32_t>(
        static_cast<uint32_t>(tokens.size()),
        CONTEXT_TOKENS);
    context_params.n_ctx = CONTEXT_TOKENS;
    context_params.no_perf = true;
    llama_ptr<llama_context> context(
        llama_init_from_model(model.get(), context_params),
        llama_free);
    if (!context) throw std::runtime_error("create context");

    auto chain_params = llama_sampler_chain_default_params();
    chain_params.no_perf = true;
    llama_ptr<llama_sampler> sampler(
        llama_sampler_chain_init(chain_params),
        llama_sampler_free);
    llama_sampler_chain_add(sampler.get(), llama_sampler_init_greedy());

    llama_batch batch =
        llama_batch_get_one(tokens.data(), static_cast<int32_t>(tokens.size()));
    std::string output;
    for (int generated = 0; generated < output_tokens; ++generated) {
        if (llama_decode(context.get(), batch) != 0) {
            throw std::runtime_error("decode");
        }
        llama_token token =
            llama_sampler_sample(sampler.get(), context.get(), -1);
        if (llama_vocab_is_eog(vocab, token)) return output;
        output += token_piece(vocab, token);
        if (output.size() > OUTPUT_MAX_BYTES) {
            throw std::runtime_error("output-byte-limit");
        }
        batch = llama_batch_get_one(&token, 1);
    }
    throw std::runtime_error("output-truncated");
}

}  // namespace

int main() {
    std::string request_id;
    try {
        const json request = json::parse(voxloom::read_frame());
        request_id = request.at("requestId").get<std::string>();
        const std::string model_path =
            request.at("modelPath").get<std::string>();
        const std::string prompt = request.at("prompt").get<std::string>();
        const std::string text = generate(model_path, prompt);
        voxloom::write_frame({
            {"error", nullptr},
            {"requestId", request_id},
            {"status", "ok"},
            {"text", text},
        });
        return 0;
    } catch (const std::exception & error) {
        std::cerr << "cleanup worker: " << error.what() << "\n";
        try {
            voxloom::write_frame({
                {"error", error.what()},
                {"requestId", request_id},
                {"status", "error"},
                {"text", nullptr},
            });
        } catch (...) {
        }
        return 1;
    }
}

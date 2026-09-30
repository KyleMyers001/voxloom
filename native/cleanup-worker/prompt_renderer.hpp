#pragma once

#include "chat.h"
#include "llama.h"
#include "safety.hpp"

#include <string>

namespace voxloom {

// Generation and both template checks share message roles, thinking controls,
// and assistant-prefill rendering. A source string is only for weight-free smoke;
// production and --model checks always use the actual GGUF metadata.
inline std::string render_prompt(
    const llama_model * model,
    const std::string & content,
    const std::string & source = "") {
    auto templates = model
        ? common_chat_templates_init(model, "")
        : common_chat_templates_init(
            nullptr, source, "<|im_start|>", "<|im_end|>");
    if (!common_chat_templates_support_enable_thinking(templates.get())) {
        throw WorkerError(Failure::runtime);
    }
    common_chat_templates_inputs inputs;
    inputs.enable_thinking = false;
    inputs.messages = {{"user", content}};
    return common_chat_templates_apply(templates.get(), inputs).prompt;
}

}  // namespace voxloom

#pragma once

#include "llama.h"

namespace voxloom {

class GenerationToken {
public:
    llama_batch batch(llama_token sampled) {
        token_ = sampled;
        return llama_batch_get_one(&token_, 1);
    }

    const llama_token * address() const {
        return &token_;
    }

private:
    llama_token token_ = LLAMA_TOKEN_NULL;
};

}  // namespace voxloom

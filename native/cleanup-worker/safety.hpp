#pragma once

#include <stdexcept>
#include <string>
#include <string_view>

namespace voxloom {

constexpr size_t OUTPUT_MAX_BYTES = 32'000;

enum class Failure {
    model_missing, context_overflow, invalid_utf8, invalid_text,
    output_limit, output_truncated, invalid_request, runtime,
};

// Only fixed, reviewed diagnostics cross IPC. Never reflect library exception
// text: JSON/template/tokenizer errors can include transcript or prompt bytes.
class WorkerError final : public std::exception {
public:
    explicit WorkerError(Failure failure) : failure_(failure) {}
    Failure failure() const noexcept { return failure_; }
    const char * code() const noexcept {
        switch (failure_) {
            case Failure::model_missing: return "model-missing";
            case Failure::context_overflow: return "context-overflow";
            case Failure::invalid_utf8:
            case Failure::invalid_text:
            case Failure::output_limit:
            case Failure::output_truncated: return "invalid-output";
            default: return "runtime-error";
        }
    }
    const char * what() const noexcept override {
        switch (failure_) {
            case Failure::model_missing: return "cleanup model is unavailable";
            case Failure::context_overflow: return "cleanup context limit exceeded";
            case Failure::invalid_utf8: return "cleanup output is not valid UTF-8";
            case Failure::invalid_text: return "cleanup output contains unsafe characters";
            case Failure::output_limit: return "cleanup output byte limit exceeded";
            case Failure::output_truncated: return "cleanup output was truncated";
            case Failure::invalid_request: return "invalid cleanup request";
            default: return "cleanup worker failed";
        }
    }
private:
    Failure failure_;
};

inline bool valid_utf8(std::string_view text) {
    size_t index = 0;
    while (index < text.size()) {
        const auto first = static_cast<unsigned char>(text[index++]);
        if (first <= 0x7f) continue;
        size_t continuation;
        unsigned char lower = 0x80, upper = 0xbf;
        if (first >= 0xc2 && first <= 0xdf) {
            continuation = 1;
        } else if (first >= 0xe0 && first <= 0xef) {
            continuation = 2;
            if (first == 0xe0) lower = 0xa0;  // No overlong encodings.
            if (first == 0xed) upper = 0x9f;  // No surrogate code points.
        } else if (first >= 0xf0 && first <= 0xf4) {
            continuation = 3;
            if (first == 0xf0) lower = 0x90;
            if (first == 0xf4) upper = 0x8f;  // At most U+10FFFF.
        } else {
            return false;
        }
        if (text.size() - index < continuation) return false;
        for (size_t part = 0; part < continuation; ++part) {
            const auto byte = static_cast<unsigned char>(text[index++]);
            if (byte < lower || byte > upper) return false;
            lower = 0x80;
            upper = 0xbf;
        }
    }
    return true;
}

inline void validate_output(std::string_view text) {
    if (text.size() > OUTPUT_MAX_BYTES) throw WorkerError(Failure::output_limit);
    if (!valid_utf8(text)) throw WorkerError(Failure::invalid_utf8);
    // Replacement is not repair. A literal U+FFFD also conservatively falls back
    // to the original transcript, rather than claiming successful cleanup.
    if (text.find("\xEF\xBF\xBD") != std::string_view::npos) {
        throw WorkerError(Failure::invalid_text);
    }
    for (const unsigned char byte : text) {
        if ((byte < 0x20 && byte != '\n' && byte != '\r' && byte != '\t')
            || byte == 0x7f) {
            throw WorkerError(Failure::invalid_text);
        }
    }
}

}  // namespace voxloom

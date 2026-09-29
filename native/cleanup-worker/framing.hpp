#pragma once

#include <nlohmann/json.hpp>

#include <array>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>

namespace voxloom {

constexpr size_t FRAME_MAX_BYTES = 128 * 1024;

inline std::string read_frame() {
    std::array<unsigned char, 4> header{};
    std::cin.read(
        reinterpret_cast<char *>(header.data()),
        static_cast<std::streamsize>(header.size()));
    if (!std::cin) throw std::runtime_error("read frame header");
    const uint32_t size =
        (static_cast<uint32_t>(header[0]) << 24) |
        (static_cast<uint32_t>(header[1]) << 16) |
        (static_cast<uint32_t>(header[2]) << 8) |
        static_cast<uint32_t>(header[3]);
    if (size == 0 || size > FRAME_MAX_BYTES) {
        throw std::runtime_error("invalid frame size");
    }
    std::string body(size, '\0');
    std::cin.read(body.data(), static_cast<std::streamsize>(body.size()));
    if (!std::cin) throw std::runtime_error("read frame body");
    return body;
}

inline void write_frame(const nlohmann::json & value) {
    const std::string body = value.dump();
    if (body.empty() || body.size() > FRAME_MAX_BYTES) {
        throw std::runtime_error("response frame exceeds limit");
    }
    const auto size = static_cast<uint32_t>(body.size());
    const std::array<unsigned char, 4> header{
        static_cast<unsigned char>((size >> 24) & 0xff),
        static_cast<unsigned char>((size >> 16) & 0xff),
        static_cast<unsigned char>((size >> 8) & 0xff),
        static_cast<unsigned char>(size & 0xff),
    };
    std::cout.write(
        reinterpret_cast<const char *>(header.data()),
        static_cast<std::streamsize>(header.size()));
    std::cout.write(body.data(), static_cast<std::streamsize>(body.size()));
    std::cout.flush();
}

}  // namespace voxloom

#pragma once

#include "safety.hpp"

#include <array>
#include <cstdio>
#include <iostream>
#include <string>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace voxloom {

inline void require_model(const std::string & path) {
    // /dev/fd/N is the already-verified inherited descriptor, so do not apply
    // O_NOFOLLOW to this alias. Integrity is checked by the parent on that fd.
    const int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NONBLOCK);
    if (fd < 0) throw WorkerError(Failure::model_missing);
    struct stat metadata {};
    std::array<char, 4> magic{};
    const bool regular = fstat(fd, &metadata) == 0 && S_ISREG(metadata.st_mode);
    const auto count = regular ? pread(fd, magic.data(), magic.size(), 0) : -1;
    close(fd);
    if (count != static_cast<ssize_t>(magic.size())
        || magic != std::array<char, 4>{'G', 'G', 'U', 'F'}) {
        throw WorkerError(Failure::model_missing);
    }
}

inline void discard_output(int destination) {
    const int fd = open("/dev/null", O_WRONLY | O_CLOEXEC);
    if (fd < 0) throw WorkerError(Failure::runtime);
    if (fd == destination) return;
    const int result = dup2(fd, destination);
    close(fd);
    if (result < 0) throw WorkerError(Failure::runtime);
}

inline void silence_stderr() {
    // This is a disposable worker process, not the app. Backend/template logs
    // may quote prompts; retain only our bounded, fixed IPC diagnostics.
    discard_output(STDERR_FILENO);
}

class QuietStdout final {
public:
    QuietStdout() {
        std::cout.flush();
        std::fflush(stdout);
        saved_ = fcntl(STDOUT_FILENO, F_DUPFD_CLOEXEC, 3);
        if (saved_ < 0) throw WorkerError(Failure::runtime);
        try {
            discard_output(STDOUT_FILENO);
        } catch (...) {
            close(saved_);
            throw;
        }
    }
    QuietStdout(const QuietStdout &) = delete;
    QuietStdout & operator=(const QuietStdout &) = delete;
    ~QuietStdout() {
        // Flush dependency buffers into /dev/null before restoring protocol IO,
        // including during exception unwinding.
        std::cout.flush();
        std::fflush(stdout);
        dup2(saved_, STDOUT_FILENO);
        close(saved_);
    }
private:
    int saved_;
};

}  // namespace voxloom

//! Worker spawn tests: the model on fd 3, relocation above stdio (R11),
//! close-on-exec (R18), and a cleared environment (BUS-98, BUS-113).

#[cfg(unix)]
#[test]
fn relocate_puts_model_fd_at_or_above_three() {
    use super::relocate_above_stdio;
    use std::os::fd::AsRawFd;

    let file = tempfile_model("relocate");
    let relocated = relocate_above_stdio(&file).unwrap();
    assert!(
        relocated.as_raw_fd() >= 3,
        "relocated fd must stay above stdio, got {}",
        relocated.as_raw_fd()
    );
}

/// R11: with stdio slots free, a plain dup would land on 0–2. Checked in a
/// forked child so closing fd 0 cannot race the other test threads.
#[cfg(unix)]
#[test]
fn relocate_stays_above_stdio_when_fd_zero_is_free() {
    use super::relocate_above_stdio;
    use std::os::fd::AsRawFd;

    let file = tempfile_model("relocate-free-stdin");
    // SAFETY: the child only closes a descriptor, calls fcntl, and _exits.
    let pid = unsafe { libc::fork() };
    assert!(pid >= 0, "fork");
    if pid == 0 {
        let code = unsafe {
            libc::close(0);
            match relocate_above_stdio(&file) {
                Ok(fd) if fd.as_raw_fd() >= 3 => 0,
                _ => 1,
            }
        };
        unsafe { libc::_exit(code) };
    }
    let mut status = 0;
    assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
    assert!(
        libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0,
        "relocated fd must not reuse a free stdio slot"
    );
}

/// R18: the relocated handle is close-on-exec, so only the worker (via the
/// pre_exec dup2 onto fd 3) inherits it, never another child process.
#[cfg(unix)]
#[test]
fn relocated_model_fd_is_close_on_exec() {
    use super::relocate_above_stdio;
    use std::os::fd::AsRawFd;

    let file = tempfile_model("relocate-cloexec");
    let relocated = relocate_above_stdio(&file).unwrap();
    // SAFETY: F_GETFD only reads the descriptor flags.
    let flags = unsafe { libc::fcntl(relocated.as_raw_fd(), libc::F_GETFD) };
    assert!(flags >= 0, "F_GETFD");
    assert_ne!(
        flags & libc::FD_CLOEXEC,
        0,
        "relocated fd must be close-on-exec"
    );
}

/// The worker starts with an empty environment (BUS-16 PR 3c-1).
#[cfg(unix)]
#[test]
fn spawn_clears_the_environment() {
    use crate::cleanup::test_support::{wait_until, write_executable};
    use std::time::Duration;

    let root = spawn_root("spawn-env");
    let model = std::fs::File::open(root.join("model.gguf")).unwrap();
    let marker = root.join("env");
    let worker = root.join("worker.py");
    write_executable(
        &worker,
        &format!(
            "#!/usr/bin/env python3\nimport os\nopen(r'{0}', 'w').write(' '.join(sorted(os.environ)) + '\\n')\n",
            marker.display()
        ),
    );
    let process = super::WorkerProcess::spawn(&worker, &model).unwrap();
    let seen = wait_until(Duration::from_secs(2), || {
        std::fs::read_to_string(&marker).is_ok_and(|text| text.ends_with('\n'))
    });
    process.handle.finish();
    assert!(seen, "worker never ran");
    let names = std::fs::read_to_string(&marker).unwrap();
    assert!(std::env::var_os("PATH").is_some(), "test needs PATH set");
    for name in ["PATH", "HOME"] {
        assert!(
            !names.split_whitespace().any(|seen| seen == name),
            "{name} leaked into the worker: {names}"
        );
    }
    let _ = std::fs::remove_dir_all(&root);
}

/// The child must see the model on fd 3 via the relocated descriptor.
#[cfg(unix)]
#[test]
fn spawn_passes_relocated_model_on_fd_three() {
    let root = spawn_root("spawn-fd3");
    let model = std::fs::File::open(root.join("model.gguf")).unwrap();
    assert_child_reads_model_on_fd_three(&root, &model);
    let _ = std::fs::remove_dir_all(&root);
}

/// A model opened while stdin was closed lands on fd 0, which the child's
/// stdin pipe replaces. Only the relocated descriptor still names the
/// model, so spawning from the original fd would hand the pipe to fd 3.
#[cfg(unix)]
#[test]
fn spawn_uses_relocated_fd_when_model_sits_on_stdin() {
    use std::fs::File;
    use std::mem::ManuallyDrop;
    use std::os::fd::{AsRawFd, FromRawFd};

    let root = spawn_root("spawn-fd0");
    let model = File::open(root.join("model.gguf")).unwrap();
    // Borrow fd 0 for the spawn, then restore the test process's stdin.
    // Nothing in the test harness reads stdin meanwhile.
    // SAFETY: dup/dup2/close on fds this test owns; fd 0 is wrapped in
    // ManuallyDrop so it is never closed by the File.
    let saved = unsafe { libc::dup(0) };
    assert!(saved >= 0, "save stdin");
    assert_eq!(unsafe { libc::dup2(model.as_raw_fd(), 0) }, 0);
    let on_stdin = ManuallyDrop::new(unsafe { File::from_raw_fd(0) });
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        assert_child_reads_model_on_fd_three(&root, &on_stdin)
    }));
    unsafe {
        libc::dup2(saved, 0);
        libc::close(saved);
    }
    let _ = std::fs::remove_dir_all(&root);
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

#[cfg(unix)]
fn spawn_root(label: &str) -> std::path::PathBuf {
    let root = crate::cleanup::test_support::test_root().join(label);
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("model.gguf"), b"GGUFtest").unwrap();
    root
}

#[cfg(unix)]
fn assert_child_reads_model_on_fd_three(root: &std::path::Path, model: &std::fs::File) {
    use crate::cleanup::test_support::{wait_until, write_executable};
    use std::time::Duration;

    let marker = root.join("fd3-bytes");
    let worker = root.join("worker.py");
    write_executable(
        &worker,
        &format!(
            "#!/usr/bin/env python3\nimport os\nopen(r'{0}', 'wb').write(os.read(3, 8))\n",
            marker.display()
        ),
    );
    let process = super::WorkerProcess::spawn(&worker, model).unwrap();
    let seen = wait_until(Duration::from_secs(2), || {
        std::fs::read(&marker).ok().as_deref() == Some(b"GGUFtest".as_slice())
    });
    process.handle.finish();
    assert!(seen, "spawn must inherit the relocated model on fd 3");
}

#[cfg(unix)]
fn tempfile_model(label: &str) -> std::fs::File {
    let path = crate::cleanup::test_support::test_root()
        .join(format!("worker-fd-{label}-{}.gguf", std::process::id()));
    std::fs::write(&path, b"GGUFtest").unwrap();
    std::fs::File::open(path).unwrap()
}

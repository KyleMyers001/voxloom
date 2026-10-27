//! Test-only helpers shared by the cleanup worker tests (BUS-98).

use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

const ROOT_PREFIX: &str = "voxloom-test-";

/// This test process's scratch directory, `voxloom-test-<pid>` in the system
/// temp dir. The first call removes the directories of test processes that
/// are no longer running, so repeated runs do not pile up entries in /tmp.
pub fn test_root() -> &'static Path {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        let temp = std::env::temp_dir();
        remove_dead_roots(&temp);
        let root = temp.join(format!("{ROOT_PREFIX}{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        root
    })
}

fn remove_dead_roots(temp: &Path) {
    let Ok(entries) = fs::read_dir(temp) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let pid = name
            .to_str()
            .and_then(|name| name.strip_prefix(ROOT_PREFIX))
            .and_then(|pid| pid.parse::<libc::pid_t>().ok());
        if pid.is_some_and(|pid| !process_exists(pid)) {
            // Best effort: another user's or a racing run's directory may refuse.
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// Whether `pid` names a process (running or not yet reaped).
pub fn process_exists(pid: libc::pid_t) -> bool {
    // SAFETY: signal 0 only checks the process; it does not signal it.
    let signalled = unsafe { libc::kill(pid, 0) } == 0;
    signalled || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

/// Polls `condition` every 10 ms until it holds or `timeout` passes.
pub fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if condition() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

const ENV_PYTHON: &str = "#!/usr/bin/env python3\n";

/// Workers start with an empty environment (env_clear), so `/usr/bin/env`
/// would search its built-in default path instead of this process's PATH.
/// On macOS that finds the /usr/bin/python3 Xcode shim, which is slow to
/// start without HOME/TMPDIR and trips the short test timeouts. Pin the
/// interpreter this test process would run instead.
fn with_python_path(contents: &str) -> String {
    let Some(body) = contents.strip_prefix(ENV_PYTHON) else {
        return contents.to_owned();
    };
    format!("#!{}\n{body}", python3().display())
}

fn python3() -> &'static Path {
    static PYTHON: OnceLock<PathBuf> = OnceLock::new();
    PYTHON.get_or_init(|| {
        std::env::var_os("PATH")
            .iter()
            .flat_map(std::env::split_paths)
            .map(|dir| dir.join("python3"))
            .find(|candidate| candidate.is_file())
            .expect("python3 on PATH for the cleanup worker tests")
    })
}

/// Installs an executable script without this process ever holding it open
/// for writing. A write descriptor opened by one test thread is inherited by
/// a child another thread is forking (until that child execs), and exec of a
/// file that is open for writing fails with ETXTBSY. So the text goes to a
/// side file that is never executed, a separate `cp` process writes the
/// executable copy, and a rename puts it in place.
pub fn write_executable(path: &Path, contents: &str) {
    let source = path.with_extension("source");
    let staged = path.with_extension("staged");
    fs::write(&source, with_python_path(contents)).unwrap();
    let status = Command::new("cp")
        .arg(&source)
        .arg(&staged)
        .status()
        .unwrap();
    assert!(status.success(), "cp {} failed: {status}", source.display());
    fs::set_permissions(&staged, fs::Permissions::from_mode(0o700)).unwrap();
    fs::rename(&staged, path).unwrap();
}

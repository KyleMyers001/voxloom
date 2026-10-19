//! Shared fake-worker fixtures for supervisor tests (Python stub workers).

use super::*;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::thread;

fn fake_root(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("voxloom-supervisor-{}-{name}", std::process::id(),))
}

fn fake_worker(name: &str, body: &str) -> PathBuf {
    let root = fake_root(name);
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let path = root.join("worker.py");
    fs::write(&path, format!("#!/usr/bin/env python3\n{body}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    path
}

fn model_file(name: &str) -> File {
    let path = std::env::temp_dir().join(format!(
        "voxloom-supervisor-model-{}-{name}",
        std::process::id(),
    ));
    fs::write(&path, b"GGUFtest").unwrap();
    File::open(path).unwrap()
}

const FRAMING: &str = r#"
import json, struct, sys
def read():
    size = struct.unpack('>I', sys.stdin.buffer.read(4))[0]
    return json.loads(sys.stdin.buffer.read(size))
def write(value):
    data = json.dumps(value).encode()
    sys.stdout.buffer.write(struct.pack('>I', len(data)) + data)
    sys.stdout.buffer.flush()
"#;

fn success_worker(name: &str) -> PathBuf {
    fake_worker(
        name,
        &format!(
            r#"{FRAMING}
request = read()
with open(request["modelPath"], "rb") as model:
    assert model.read() == b"GGUFtest"
write({{"error": None, "errorCode": None, "requestId": request["requestId"],
       "status": "ok", "text": "cleaned"}})
"#
        ),
    )
}

mod lifecycle;
mod recovery;
mod responses;

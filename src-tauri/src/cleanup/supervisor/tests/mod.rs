//! Shared fake-worker fixtures for supervisor tests (Python stub workers).

use super::*;
use crate::cleanup::test_support::{test_root, write_executable};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::thread;

fn fake_root(name: &str) -> PathBuf {
    test_root().join(format!("supervisor-{name}"))
}

fn fake_worker(name: &str, body: &str) -> PathBuf {
    let root = fake_root(name);
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let path = root.join("worker.py");
    write_executable(&path, &format!("#!/usr/bin/env python3\n{body}\n"));
    path
}

fn model_file(name: &str) -> File {
    let path = test_root().join(format!("supervisor-model-{name}"));
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

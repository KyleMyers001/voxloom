//! Resolve the target process's executable and ask `decide::host` whether it
//! is known to honor Unicode key events (Chromium browsers / Electron).

use std::ffi::c_void;

use crate::delivery::decide::unicode_typing_supported;

extern "C" {
    // libproc (libSystem).
    fn proc_pidpath(pid: i32, buffer: *mut c_void, buffersize: u32) -> i32;
}

const PROC_PIDPATHINFO_MAXSIZE: usize = 4096;

fn executable_path(pid: i32) -> Option<String> {
    let mut buf = vec![0u8; PROC_PIDPATHINFO_MAXSIZE];
    let len = unsafe { proc_pidpath(pid, buf.as_mut_ptr() as *mut c_void, buf.len() as u32) };
    if len <= 0 {
        return None;
    }
    buf.truncate(len as usize);
    String::from_utf8(buf).ok()
}

pub fn unicode_typing_ok(pid: i32) -> bool {
    executable_path(pid)
        .is_some_and(|exe| unicode_typing_supported(&exe, |p| std::path::Path::new(p).exists()))
}

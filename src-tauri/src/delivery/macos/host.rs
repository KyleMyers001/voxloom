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

pub fn apple_terminal_identity(pid: i32) -> Option<bool> {
    executable_path(pid).map(|exe| crate::delivery::decide::terminal::apple_terminal_host(&exe))
}

pub fn apple_terminal(pid: i32) -> bool {
    apple_terminal_identity(pid) == Some(true)
}

pub fn unicode_typing_ok(pid: i32) -> bool {
    executable_path(pid)
        .is_some_and(|exe| unicode_typing_supported(&exe, |p| std::path::Path::new(p).exists()))
}

pub fn web_ax_activation(pid: i32) -> Option<crate::delivery::decide::host::WebAxActivation> {
    executable_path(pid).and_then(|exe| {
        crate::delivery::decide::host::web_ax_activation(&exe, |p| std::path::Path::new(p).exists())
    })
}

/// Independent of AX: never activates an application or changes focus.
pub fn frontmost_pid() -> Option<i32> {
    use objc2::{class, msg_send, runtime::AnyObject};
    objc2::rc::autoreleasepool(|_| unsafe {
        let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        let front: *mut AnyObject = msg_send![workspace, frontmostApplication];
        if front.is_null() {
            None
        } else {
            let pid: i32 = msg_send![front, processIdentifier];
            (pid > 0).then_some(pid)
        }
    })
}

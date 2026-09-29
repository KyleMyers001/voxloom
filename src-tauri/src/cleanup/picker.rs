#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::{c_char, c_void, CStr};

    type Id = *mut c_void;
    type Sel = *mut c_void;

    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> Sel;
        fn objc_msgSend();
    }

    unsafe fn class(name: &'static [u8]) -> Id {
        objc_getClass(name.as_ptr().cast())
    }

    unsafe fn sel(name: &'static [u8]) -> Sel {
        sel_registerName(name.as_ptr().cast())
    }

    unsafe fn send_id(receiver: Id, selector: Sel) -> Id {
        let function: unsafe extern "C" fn(Id, Sel) -> Id =
            std::mem::transmute(objc_msgSend as *const ());
        function(receiver, selector)
    }

    unsafe fn send_bool(receiver: Id, selector: Sel, value: bool) {
        let function: unsafe extern "C" fn(Id, Sel, bool) =
            std::mem::transmute(objc_msgSend as *const ());
        function(receiver, selector, value);
    }

    unsafe fn send_integer(receiver: Id, selector: Sel) -> i64 {
        let function: unsafe extern "C" fn(Id, Sel) -> i64 =
            std::mem::transmute(objc_msgSend as *const ());
        function(receiver, selector)
    }

    unsafe fn send_c_string(receiver: Id, selector: Sel) -> *const c_char {
        let function: unsafe extern "C" fn(Id, Sel) -> *const c_char =
            std::mem::transmute(objc_msgSend as *const ());
        function(receiver, selector)
    }

    pub fn pick_model_path() -> Result<Option<String>, String> {
        unsafe {
            let thread = send_id(class(b"NSThread\0"), sel(b"currentThread\0"));
            let is_main: unsafe extern "C" fn(Id, Sel) -> bool =
                std::mem::transmute(objc_msgSend as *const ());
            if !is_main(thread, sel(b"isMainThread\0")) {
                return Err("model picker must run on the main thread".into());
            }
            let panel = send_id(class(b"NSOpenPanel\0"), sel(b"openPanel\0"));
            send_bool(panel, sel(b"setCanChooseDirectories:\0"), false);
            send_bool(panel, sel(b"setCanChooseFiles:\0"), true);
            send_bool(panel, sel(b"setAllowsMultipleSelection:\0"), false);
            if send_integer(panel, sel(b"runModal\0")) != 1 {
                return Ok(None);
            }
            let url = send_id(panel, sel(b"URL\0"));
            let path = send_id(url, sel(b"path\0"));
            let bytes = send_c_string(path, sel(b"UTF8String\0"));
            if bytes.is_null() {
                return Err("selected model path is unavailable".into());
            }
            Ok(Some(CStr::from_ptr(bytes).to_string_lossy().into_owned()))
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn pick_model_path() -> Result<Option<String>, String> {
        Err("cleanup model import is currently available on macOS only".into())
    }
}

pub use platform::pick_model_path;

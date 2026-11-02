//! General NSPasteboard glue for the terminal paste route: a full snapshot
//! (every item, every type), a transient text write, and an exact restore.
//! Raw `msg_send!` on AppKit classes, as `host::frontmost_pid` does for
//! NSWorkspace; no extra crates. Bytes are copied out inside an autorelease
//! pool, so a `Snapshot` owns plain Rust data.

use std::ffi::{c_void, CStr, CString};

use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::{AnyObject, Bool};
use objc2::{class, msg_send};

/// NSPasteboardTypeString.
const TYPE_STRING: &str = "public.utf8-plain-text";
/// nspasteboard.org marker: clipboard managers skip the entry.
const TYPE_TRANSIENT: &str = "org.nspasteboard.TransientType";

/// Every pasteboard item as (type, bytes) pairs.
pub struct Snapshot(Vec<Vec<(CString, Vec<u8>)>>);

unsafe fn general() -> *mut AnyObject {
    msg_send![class!(NSPasteboard), generalPasteboard]
}

unsafe fn ns_string(s: &CStr) -> *mut AnyObject {
    msg_send![class!(NSString), stringWithUTF8String: s.as_ptr()]
}

unsafe fn ns_data(bytes: &[u8]) -> *mut AnyObject {
    msg_send![class!(NSData), dataWithBytes: bytes.as_ptr().cast::<c_void>(), length: bytes.len()]
}

pub fn change_count() -> i64 {
    // SAFETY: NSPasteboard.generalPasteboard / changeCount take no arguments.
    unsafe {
        let count: isize = msg_send![general(), changeCount];
        count as i64
    }
}

/// None when any type cannot be read in full (the restore would be lossy).
pub fn snapshot() -> Option<Snapshot> {
    autoreleasepool(|_| unsafe {
        let items: *mut AnyObject = msg_send![general(), pasteboardItems];
        let item_count: usize = msg_send![items, count]; // nil → 0
        let mut saved = Vec::with_capacity(item_count);
        for i in 0..item_count {
            let item: *mut AnyObject = msg_send![items, objectAtIndex: i];
            let types: *mut AnyObject = msg_send![item, types];
            let type_count: usize = msg_send![types, count];
            let mut entries = Vec::with_capacity(type_count);
            for j in 0..type_count {
                let ty: *mut AnyObject = msg_send![types, objectAtIndex: j];
                let name: *const std::ffi::c_char = msg_send![ty, UTF8String];
                if name.is_null() {
                    return None;
                }
                let data: *mut AnyObject = msg_send![item, dataForType: ty];
                if data.is_null() {
                    return None;
                }
                let len: usize = msg_send![data, length];
                let bytes: *const c_void = msg_send![data, bytes];
                let copy = if len == 0 || bytes.is_null() {
                    Vec::new()
                } else {
                    std::slice::from_raw_parts(bytes.cast::<u8>(), len).to_vec()
                };
                entries.push((CStr::from_ptr(name).to_owned(), copy));
            }
            saved.push(entries);
        }
        Some(Snapshot(saved))
    })
}

/// Replace the clipboard with `text`, flagged transient. Returns the change
/// count right after our write, for the restore guard.
pub fn write_transient(text: &str) -> Result<i64, String> {
    let text = CString::new(text).map_err(|_| "transcript contains NUL".to_string())?;
    autoreleasepool(|_| unsafe {
        let pb = general();
        let _: isize = msg_send![pb, clearContents];
        let string = ns_string(&text);
        let ty = ns_string(&CString::new(TYPE_STRING).unwrap_or_default());
        let ok: Bool = msg_send![pb, setString: string, forType: ty];
        if !ok.as_bool() {
            return Err("pasteboard refused the transcript".to_string());
        }
        // Best effort: the marker only keeps clipboard managers away.
        let marker = ns_string(&CString::new(TYPE_TRANSIENT).unwrap_or_default());
        let _: Bool = msg_send![pb, setData: ns_data(&[]), forType: marker];
        Ok(change_count())
    })
}

/// Put `saved` back exactly: same items, same types, same bytes.
pub fn restore(saved: &Snapshot) -> Result<(), String> {
    autoreleasepool(|_| unsafe {
        let pb = general();
        let _: isize = msg_send![pb, clearContents];
        let mut items: Vec<Retained<AnyObject>> = Vec::new();
        for entries in &saved.0 {
            let item: Retained<AnyObject> = msg_send![class!(NSPasteboardItem), new];
            for (ty, bytes) in entries {
                let ok: Bool = msg_send![&*item, setData: ns_data(bytes), forType: ns_string(ty)];
                if !ok.as_bool() {
                    return Err("pasteboard refused a saved type".to_string());
                }
            }
            items.push(item);
        }
        if items.is_empty() {
            return Ok(()); // the clipboard was empty
        }
        let ptrs: Vec<*const AnyObject> = items.iter().map(|i| &**i as *const AnyObject).collect();
        let array: *mut AnyObject =
            msg_send![class!(NSArray), arrayWithObjects: ptrs.as_ptr(), count: ptrs.len()];
        let ok: Bool = msg_send![pb, writeObjects: array];
        if ok.as_bool() {
            Ok(())
        } else {
            Err("pasteboard refused the saved items".to_string())
        }
    })
}

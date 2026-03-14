/// Check if Google Meet is active in any browser window.
/// Detects any visible window whose title starts with "Meet - ".
pub fn is_google_meet_active() -> bool {
    #[cfg(target_os = "windows")]
    return check_meet_window();

    #[cfg(not(target_os = "windows"))]
    return false;
}

#[cfg(target_os = "windows")]
fn check_meet_window() -> bool {
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, IsWindowVisible};

    static MEET_FOUND: AtomicBool = AtomicBool::new(false);
    MEET_FOUND.store(false, Ordering::SeqCst);

    unsafe extern "system" fn enum_proc(hwnd: HWND, _: LPARAM) -> BOOL {
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        let mut buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, windows::core::PWSTR(buf.as_mut_ptr()), 512);
        if len > 0 {
            let title = String::from_utf16_lossy(&buf[..len as usize]);
            if title.starts_with("Meet - ") {
                MEET_FOUND.store(true, Ordering::SeqCst);
                return BOOL(0); // Stop enumeration
            }
        }
        BOOL(1)
    }

    let _ = unsafe { EnumWindows(Some(enum_proc), LPARAM(0)) };
    MEET_FOUND.load(Ordering::SeqCst)
}

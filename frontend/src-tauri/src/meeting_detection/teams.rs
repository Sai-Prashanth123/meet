use sysinfo::System;

/// Check if a Microsoft Teams meeting is active.
/// Requires ms-teams.exe / Teams.exe to be running AND a window title containing
/// "| Microsoft Teams".
pub fn is_teams_meeting_active() -> bool {
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let teams_running = sys.processes().values().any(|p| {
        let name = p.name().to_string_lossy().to_lowercase();
        name == "ms-teams.exe" || name == "teams.exe"
    });

    if !teams_running {
        return false;
    }

    #[cfg(target_os = "windows")]
    return check_teams_window();

    #[cfg(not(target_os = "windows"))]
    return false;
}

#[cfg(target_os = "windows")]
fn check_teams_window() -> bool {
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, IsWindowVisible};

    static TEAMS_FOUND: AtomicBool = AtomicBool::new(false);
    TEAMS_FOUND.store(false, Ordering::SeqCst);

    unsafe extern "system" fn enum_proc(hwnd: HWND, _: LPARAM) -> BOOL {
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        let mut buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut buf);
        if len > 0 {
            let title = String::from_utf16_lossy(&buf[..len as usize]);
            if title.contains("| Microsoft Teams") {
                TEAMS_FOUND.store(true, Ordering::SeqCst);
                return BOOL(0); // Stop enumeration
            }
        }
        BOOL(1)
    }

    let _ = unsafe { EnumWindows(Some(enum_proc), LPARAM(0)) };
    TEAMS_FOUND.load(Ordering::SeqCst)
}

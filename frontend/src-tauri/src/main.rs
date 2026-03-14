#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use log;
use env_logger;

#[cfg(target_os = "windows")]
fn show_windows_error(title: &str, message: &str) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::iter::once;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR};
    use windows::core::PCWSTR;

    let wide_title: Vec<u16> = OsStr::new(title).encode_wide().chain(once(0)).collect();
    let wide_msg: Vec<u16> = OsStr::new(message).encode_wide().chain(once(0)).collect();

    unsafe {
        let _ = MessageBoxW(
            None,
            PCWSTR(wide_msg.as_ptr()),
            PCWSTR(wide_title.as_ptr()),
            MB_ICONERROR,
        );
    }
}

fn main() {
    #[cfg(all(not(debug_assertions), target_os = "windows"))]
    {
        let orig_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let msg = format!(
                "Meetily encountered a fatal error and must close.\n\n{}\n\nPlease reinstall or contact support.",
                info
            );
            show_windows_error("Meetily — Fatal Error", &msg);
            orig_hook(info);
        }));
    }

    std::env::set_var("RUST_LOG", "info");
    env_logger::init();

    log::info!("Starting application...");
    app_lib::run();
}

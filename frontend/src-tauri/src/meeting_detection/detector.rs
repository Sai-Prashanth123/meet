use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use chrono::Local;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::{Mutex, RwLock};

use super::meet::is_google_meet_active;
use super::teams::is_teams_meeting_active;
use super::zoom::is_zoom_meeting_active;

// ── Public types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectedApp {
    Zoom,
    MicrosoftTeams,
    GoogleMeet,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectorConfig {
    pub enabled: bool,
    pub detect_zoom: bool,
    pub detect_teams: bool,
    pub detect_google_meet: bool,
    pub auto_start_recording: bool,
    pub auto_stop_recording: bool,
    /// Seconds to wait after a meeting disappears before emitting meeting-ended
    pub stop_grace_period_secs: u64,
    /// Polling interval in seconds (default: 5)
    pub poll_interval_secs: u64,
}

impl Default for DetectorConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            detect_zoom: true,
            detect_teams: true,
            detect_google_meet: true,
            auto_start_recording: false,
            auto_stop_recording: false,
            stop_grace_period_secs: 30,
            poll_interval_secs: 5,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingDetectedEvent {
    pub app: DetectedApp,
    pub suggested_meeting_name: String,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingEndedEvent {
    pub app: DetectedApp,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingStatus {
    pub app: DetectedApp,
    pub in_meeting: bool,
}

// ── Global state ──────────────────────────────────────────────────────────────

/// Writeable config; synced from frontend via `set_detection_config` command.
pub static DETECTOR_CONFIG: LazyLock<Arc<RwLock<DetectorConfig>>> =
    LazyLock::new(|| Arc::new(RwLock::new(DetectorConfig::default())));

/// Per-app "was in meeting last poll?" state for change detection.
static PREV_MEETING_STATE: LazyLock<Mutex<HashMap<String, bool>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Per-app grace-period start timestamp (set when a meeting disappears).
static GRACE_PERIOD_TIMERS: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Prevents double-spawning the polling task.
static DETECTOR_RUNNING: AtomicBool = AtomicBool::new(false);

/// Mirrors `config.enabled` synchronously so `tray.rs` can read it without async.
pub static DETECTION_ENABLED: AtomicBool = AtomicBool::new(false);

// ── Helpers ───────────────────────────────────────────────────────────────────

fn app_key(app: &DetectedApp) -> &'static str {
    match app {
        DetectedApp::Zoom => "zoom",
        DetectedApp::MicrosoftTeams => "teams",
        DetectedApp::GoogleMeet => "meet",
    }
}

fn generate_meeting_name(app: &DetectedApp) -> String {
    let label = match app {
        DetectedApp::Zoom => "Zoom Meeting",
        DetectedApp::MicrosoftTeams => "Teams Meeting",
        DetectedApp::GoogleMeet => "Google Meet",
    };
    format!("{} - {}", label, Local::now().format("%d %b %Y %H:%M"))
}

fn current_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ── Detection service ─────────────────────────────────────────────────────────

/// Spawns the background polling task. Safe to call multiple times; subsequent
/// calls are no-ops (guarded by `DETECTOR_RUNNING`).
pub fn spawn_detection_service<R: Runtime>(app: AppHandle<R>) {
    if DETECTOR_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        log::warn!("Meeting detection service already running; skipping spawn");
        return;
    }

    tauri::async_runtime::spawn(async move {
        log::info!("Meeting detection service started");
        loop {
            let config = DETECTOR_CONFIG.read().await.clone();

            if config.enabled {
                poll_meeting_apps(&app, &config).await;
            }

            tokio::time::sleep(Duration::from_secs(config.poll_interval_secs.max(1))).await;
        }
    });
}

async fn poll_meeting_apps<R: Runtime>(app: &AppHandle<R>, config: &DetectorConfig) {
    let checks: &[(DetectedApp, bool)] = &[
        (DetectedApp::Zoom, config.detect_zoom),
        (DetectedApp::MicrosoftTeams, config.detect_teams),
        (DetectedApp::GoogleMeet, config.detect_google_meet),
    ];

    for (detected_app, should_check) in checks {
        if !should_check {
            continue;
        }
        let in_meeting = check_app_meeting_status(detected_app).await;
        process_meeting_state(app, detected_app, in_meeting, config).await;
    }
}

async fn check_app_meeting_status(app: &DetectedApp) -> bool {
    #[cfg(target_os = "windows")]
    {
        match app {
            DetectedApp::Zoom => is_zoom_meeting_active().await,
            DetectedApp::MicrosoftTeams => is_teams_meeting_active(),
            DetectedApp::GoogleMeet => is_google_meet_active(),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app; // suppress unused warning
        false
    }
}

async fn process_meeting_state<R: Runtime>(
    app: &AppHandle<R>,
    detected_app: &DetectedApp,
    in_meeting: bool,
    config: &DetectorConfig,
) {
    let key = app_key(detected_app).to_string();

    let mut prev = PREV_MEETING_STATE.lock().await;
    let was_in_meeting = prev.get(&key).copied().unwrap_or(false);

    if in_meeting && !was_in_meeting {
        // ── Meeting started ─────────────────────────────────────────────────
        prev.insert(key.clone(), true);
        drop(prev);

        // Clear any lingering grace-period timer
        GRACE_PERIOD_TIMERS.lock().await.remove(&key);

        let event = MeetingDetectedEvent {
            app: detected_app.clone(),
            suggested_meeting_name: generate_meeting_name(detected_app),
            timestamp_ms: current_timestamp_ms(),
        };

        log::info!("Meeting detected: {:?}", detected_app);
        if let Err(e) = app.emit("meeting-detected", &event) {
            log::error!("Failed to emit meeting-detected: {}", e);
        }
    } else if !in_meeting && was_in_meeting {
        // ── Meeting may have ended — apply grace period ─────────────────────
        drop(prev);

        let now = Instant::now();
        let mut timers = GRACE_PERIOD_TIMERS.lock().await;

        let grace_expired = if let Some(start) = timers.get(&key) {
            now.duration_since(*start) >= Duration::from_secs(config.stop_grace_period_secs)
        } else {
            timers.insert(key.clone(), now);
            false
        };

        if grace_expired {
            timers.remove(&key);
            drop(timers);

            PREV_MEETING_STATE.lock().await.insert(key.clone(), false);

            let event = MeetingEndedEvent {
                app: detected_app.clone(),
                timestamp_ms: current_timestamp_ms(),
            };

            log::info!("Meeting ended: {:?}", detected_app);
            if let Err(e) = app.emit("meeting-ended", &event) {
                log::error!("Failed to emit meeting-ended: {}", e);
            }
        }
    } else {
        drop(prev);
        // Still in meeting — clear any grace timer that may have been started
        if in_meeting {
            GRACE_PERIOD_TIMERS.lock().await.remove(&key);
        }
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn set_detection_config(config: DetectorConfig) -> Result<(), String> {
    DETECTION_ENABLED.store(config.enabled, Ordering::SeqCst);
    let mut cfg = DETECTOR_CONFIG.write().await;
    *cfg = config;
    log::info!("Detection config updated (enabled={})", cfg.enabled);
    Ok(())
}

#[tauri::command]
pub async fn get_detection_config() -> DetectorConfig {
    DETECTOR_CONFIG.read().await.clone()
}

#[tauri::command]
pub async fn check_meeting_now() -> Vec<MeetingStatus> {
    let config = DETECTOR_CONFIG.read().await.clone();
    let mut results = Vec::new();

    #[cfg(target_os = "windows")]
    {
        if config.detect_zoom {
            results.push(MeetingStatus {
                app: DetectedApp::Zoom,
                in_meeting: is_zoom_meeting_active().await,
            });
        }
        if config.detect_teams {
            results.push(MeetingStatus {
                app: DetectedApp::MicrosoftTeams,
                in_meeting: is_teams_meeting_active(),
            });
        }
        if config.detect_google_meet {
            results.push(MeetingStatus {
                app: DetectedApp::GoogleMeet,
                in_meeting: is_google_meet_active(),
            });
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = config; // suppress unused warning
    }

    results
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_meeting_name_format() {
        let name = generate_meeting_name(&DetectedApp::Zoom);
        assert!(name.starts_with("Zoom Meeting - "), "Got: {}", name);
    }

    #[test]
    fn test_detector_config_default_is_disabled() {
        let config = DetectorConfig::default();
        assert!(!config.enabled, "Default config should have enabled=false");
    }

    #[tokio::test]
    async fn test_grace_period_not_expired_yet() {
        // Insert a fresh timer entry
        let key = "test_app".to_string();
        {
            let mut timers = GRACE_PERIOD_TIMERS.lock().await;
            timers.insert(key.clone(), Instant::now());
        }

        // With grace period 30s and a freshly-set timer, it should NOT be expired
        let timers = GRACE_PERIOD_TIMERS.lock().await;
        let start = timers.get(&key).copied().unwrap();
        let elapsed = Instant::now().duration_since(start);
        assert!(elapsed < Duration::from_secs(30), "Timer should not be expired yet");
    }

    #[tokio::test]
    async fn test_grace_period_expired() {
        // Simulate an old timer by using an Instant from 60 seconds ago (approximated)
        let key = "test_expired_app".to_string();
        {
            let mut timers = GRACE_PERIOD_TIMERS.lock().await;
            // Subtract 60s from now to simulate an old timer
            let old_instant = Instant::now()
                .checked_sub(Duration::from_secs(60))
                .unwrap_or(Instant::now());
            timers.insert(key.clone(), old_instant);
        }

        let timers = GRACE_PERIOD_TIMERS.lock().await;
        let start = timers.get(&key).copied().unwrap();
        let elapsed = Instant::now().duration_since(start);
        assert!(elapsed >= Duration::from_secs(30), "Timer should be expired");
    }
}

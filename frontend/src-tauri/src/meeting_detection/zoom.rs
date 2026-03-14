use sysinfo::System;

/// Check if Zoom meeting is active using the official local HTTP API (port 8766),
/// with CptHost.exe process presence as fallback.
pub async fn is_zoom_meeting_active() -> bool {
    match check_zoom_http_api().await {
        Ok(result) => result,
        Err(_) => check_zoom_process(),
    }
}

async fn check_zoom_http_api() -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(500))
        .build()?;

    let response = client
        .get("http://localhost:8766/v1/status")
        .send()
        .await?;

    if !response.status().is_success() {
        return Err("Non-success HTTP status".into());
    }

    let json: serde_json::Value = response.json().await?;

    let in_meeting = json
        .get("inMeeting")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    Ok(in_meeting)
}

fn check_zoom_process() -> bool {
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    sys.processes().values().any(|p| {
        let name = p.name().to_string_lossy().to_lowercase();
        name == "cpthost.exe"
    })
}

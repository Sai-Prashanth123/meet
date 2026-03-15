//! WebSocket sender for Meetily Cloud Mode.
//!
//! When cloudMode is enabled:
//! 1. Opens a WebSocket connection to the cloud gateway (ws://gateway:8002/stream)
//! 2. Authenticates via first text frame: {type:"auth", token:"JWT"}
//! 3. Receives f32/48 kHz mono audio chunks from the recording pipeline
//! 4. Resamples to PCM16 / 16 kHz using `rubato`
//! 5. Packs and sends binary frames every 200 ms
//! 6. Forwards real-time transcript JSON from the server back via a Tauri event

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use rubato::{FftFixedIn, Resampler};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use futures_util::{SinkExt, StreamExt};
use tokio::time::timeout;

const SOURCE_SAMPLE_RATE: usize = 48_000;
const TARGET_SAMPLE_RATE: usize = 16_000;
/// 200 ms of audio at 16 kHz = 3200 samples = 6400 bytes (PCM16)
const CHUNK_SAMPLES_16K: usize = TARGET_SAMPLE_RATE / 5; // 3200
/// Equivalent input samples at 48 kHz for 200 ms
const CHUNK_SAMPLES_48K: usize = SOURCE_SAMPLE_RATE / 5; // 9600

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ControlMessage<'a> {
    /// First frame sent after connection — carries the JWT so the token
    /// never appears in the URL (and therefore never in access logs).
    Auth {
        token: &'a str,
    },
    StartMeeting {
        meeting_id: &'a str,
        title: &'a str,
        platform: &'a str,
    },
    EndMeeting {
        meeting_id: &'a str,
    },
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ServerTranscript {
    pub meeting_id: String,
    pub text: String,
    pub timestamp_ms: u64,
    pub is_final: bool,
}

// ---------------------------------------------------------------------------
// CloudWebSocketSender
// ---------------------------------------------------------------------------

/// Handle to the cloud WebSocket sender task.
/// Created once at recording start, dropped at recording stop.
pub struct CloudWebSocketSender {
    audio_tx: mpsc::UnboundedSender<Vec<f32>>,
    /// Signals the background task to shut down gracefully.
    shutdown_tx: tokio::sync::oneshot::Sender<()>,
}

impl CloudWebSocketSender {
    /// Connect to the cloud gateway and start the background send task.
    ///
    /// The JWT `token` is sent in the first WebSocket text frame instead of the
    /// URL query string so that it never appears in server access logs.
    ///
    /// # Arguments
    /// * `gateway_url`   – e.g. `"ws://localhost:8002/stream"` (NO token in URL)
    /// * `meeting_id`    – UUID string for the current meeting
    /// * `title`         – Human-readable meeting title
    /// * `platform`      – "zoom" / "microsoft_teams" / "google_meet" / ""
    /// * `token`         – JWT access token for authentication
    /// * `transcript_cb` – Called on every final transcript from the server
    pub async fn connect(
        gateway_url: String,
        meeting_id: String,
        title: String,
        platform: String,
        token: String,
        transcript_cb: Arc<dyn Fn(ServerTranscript) + Send + Sync + 'static>,
    ) -> Result<Self> {
        let (ws_stream, _) = timeout(
            Duration::from_secs(10),
            connect_async(&gateway_url),
        )
        .await
        .map_err(|_| anyhow!("Gateway connection timed out"))?
        .map_err(|e| anyhow!("WebSocket connect failed: {e}"))?;

        let (mut ws_write, mut ws_read) = ws_stream.split();

        // Frame 1: Auth — send token in message body, NOT the URL.
        // This prevents the JWT from appearing in any server access log.
        let auth_msg = serde_json::to_string(&ControlMessage::Auth { token: &token })?;
        ws_write.send(Message::Text(auth_msg.into())).await
            .map_err(|e| anyhow!("Failed to send auth frame: {e}"))?;

        // Frame 2: Start meeting
        let start_msg = serde_json::to_string(&ControlMessage::StartMeeting {
            meeting_id: &meeting_id,
            title: &title,
            platform: &platform,
        })?;
        ws_write.send(Message::Text(start_msg.into())).await
            .map_err(|e| anyhow!("Failed to send start_meeting: {e}"))?;

        // Channel for audio chunks from the recording pipeline
        let (audio_tx, mut audio_rx) = mpsc::unbounded_channel::<Vec<f32>>();
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();

        let meeting_id_clone = meeting_id.clone();
        let ws_write = Arc::new(Mutex::new(ws_write));
        let ws_write_send = ws_write.clone();
        let ws_write_end = ws_write.clone();

        // ---- Receive task: server → transcript_cb ----
        tokio::spawn(async move {
            while let Some(msg) = ws_read.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                            if val.get("type").and_then(|v| v.as_str()) == Some("transcript") {
                                if let Ok(t) = serde_json::from_value::<ServerTranscript>(val) {
                                    transcript_cb(t);
                                }
                            }
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
        });

        // ---- Send task: audio chunks → gateway ----
        let mid = meeting_id_clone.clone();
        tokio::spawn(async move {
            // Build resampler: 48 kHz → 16 kHz, mono, chunk_size = 9600 input frames
            let mut resampler = match FftFixedIn::<f32>::new(
                SOURCE_SAMPLE_RATE,
                TARGET_SAMPLE_RATE,
                CHUNK_SAMPLES_48K,
                2, // sub-chunks
                1, // channels
            ) {
                Ok(r) => r,
                Err(e) => {
                    log::error!("[Cloud] Failed to create resampler: {e}");
                    return;
                }
            };

            let mut input_buf: Vec<f32> = Vec::with_capacity(CHUNK_SAMPLES_48K * 2);
            let meeting_id_bytes = mid.as_bytes();
            let id_len = meeting_id_bytes.len() as u32;

            loop {
                tokio::select! {
                    chunk = audio_rx.recv() => {
                        let Some(chunk) = chunk else { break };
                        input_buf.extend_from_slice(&chunk);

                        // Process complete 200 ms windows
                        while input_buf.len() >= CHUNK_SAMPLES_48K {
                            let window: Vec<f32> = input_buf.drain(..CHUNK_SAMPLES_48K).collect();
                            let output = match resampler.process(&[window], None) {
                                Ok(o) => o,
                                Err(e) => { log::warn!("[Cloud] Resample error: {e}"); continue }
                            };

                            // Convert f32 → PCM16 little-endian
                            let pcm16_bytes: Vec<u8> = output[0]
                                .iter()
                                .flat_map(|&s| {
                                    let clamped = s.clamp(-1.0, 1.0);
                                    let sample = (clamped * 32767.0) as i16;
                                    sample.to_le_bytes()
                                })
                                .collect();

                            // Pack binary frame: [4 bytes: id_len LE][meeting_id][pcm16]
                            let mut frame = Vec::with_capacity(4 + meeting_id_bytes.len() + pcm16_bytes.len());
                            frame.extend_from_slice(&id_len.to_le_bytes());
                            frame.extend_from_slice(meeting_id_bytes);
                            frame.extend_from_slice(&pcm16_bytes);

                            let mut writer = ws_write_send.lock().await;
                            if let Err(e) = writer.send(Message::Binary(frame.into())).await {
                                log::warn!("[Cloud] WebSocket send error: {e}");
                                break;
                            }
                        }
                    }
                    _ = &mut shutdown_rx => {
                        // Send end_meeting control message before closing
                        let end_msg = serde_json::to_string(&ControlMessage::EndMeeting {
                            meeting_id: &meeting_id_clone,
                        }).unwrap_or_default();
                        let mut writer = ws_write_end.lock().await;
                        let _ = writer.send(Message::Text(end_msg.into())).await;
                        let _ = writer.send(Message::Close(None)).await;
                        break;
                    }
                }
            }
        });

        Ok(CloudWebSocketSender { audio_tx, shutdown_tx })
    }

    /// Push a mono f32 audio chunk (48 kHz) from the recording pipeline.
    pub fn send_audio(&self, samples: Vec<f32>) -> Result<()> {
        self.audio_tx
            .send(samples)
            .map_err(|_| anyhow!("Cloud sender channel closed"))
    }

    /// Gracefully shut down the WebSocket connection.
    pub fn stop(self) {
        let _ = self.shutdown_tx.send(());
    }

    /// Connect with exponential-backoff retry for transient gateway failures.
    ///
    /// Retries up to 6 times: delays of 1, 2, 4, 8, 16, 30 seconds plus random
    /// jitter of up to 1 second per attempt to avoid thundering herd.
    pub async fn connect_with_retry(
        gateway_url: String,
        meeting_id: String,
        title: String,
        platform: String,
        token: String,
        transcript_cb: Arc<dyn Fn(ServerTranscript) + Send + Sync + 'static>,
    ) -> Result<Self> {
        const DELAYS: [u64; 6] = [1, 2, 4, 8, 16, 30];
        let mut attempt = 0;

        loop {
            match Self::connect(
                gateway_url.clone(),
                meeting_id.clone(),
                title.clone(),
                platform.clone(),
                token.clone(),
                transcript_cb.clone(),
            )
            .await
            {
                Ok(sender) => return Ok(sender),
                Err(e) if attempt < DELAYS.len() => {
                    let base = DELAYS[attempt];
                    let jitter = rand::random::<u64>() % 2; // 0..1 s jitter
                    let wait = base + jitter;
                    log::warn!(
                        "[Cloud] Connect attempt {} failed ({e}), retrying in {wait}s …",
                        attempt + 1
                    );
                    tokio::time::sleep(Duration::from_secs(wait)).await;
                    attempt += 1;
                }
                Err(e) => return Err(e),
            }
        }
    }
}

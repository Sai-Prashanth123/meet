/**
 * TypeScript types mirroring the Rust meeting_detection structs.
 * Keep in sync with frontend/src-tauri/src/meeting_detection/detector.rs
 */

export type DetectedApp = 'zoom' | 'microsoft_teams' | 'google_meet';

export interface DetectorConfig {
  enabled: boolean;
  detect_zoom: boolean;
  detect_teams: boolean;
  detect_google_meet: boolean;
  auto_start_recording: boolean;
  auto_stop_recording: boolean;
  /** Seconds to wait after meeting disappears before emitting meeting-ended */
  stop_grace_period_secs: number;
  /** Polling interval in seconds */
  poll_interval_secs: number;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  enabled: false,
  detect_zoom: true,
  detect_teams: true,
  detect_google_meet: true,
  auto_start_recording: false,
  auto_stop_recording: false,
  stop_grace_period_secs: 30,
  poll_interval_secs: 5,
};

export interface MeetingDetectedEvent {
  app: DetectedApp;
  suggested_meeting_name: string;
  timestamp_ms: number;
}

export interface MeetingEndedEvent {
  app: DetectedApp;
  timestamp_ms: number;
}

export interface MeetingStatus {
  app: DetectedApp;
  in_meeting: boolean;
}

export function getAppDisplayName(app: DetectedApp): string {
  switch (app) {
    case 'zoom': return 'Zoom';
    case 'microsoft_teams': return 'Microsoft Teams';
    case 'google_meet': return 'Google Meet';
  }
}

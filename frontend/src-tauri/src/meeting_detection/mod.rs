pub mod detector;
pub mod meet;
pub mod teams;
pub mod zoom;

pub use detector::{
    check_meeting_now, get_detection_config, set_detection_config, spawn_detection_service,
    DetectedApp, DetectorConfig, MeetingDetectedEvent, MeetingEndedEvent, MeetingStatus,
};

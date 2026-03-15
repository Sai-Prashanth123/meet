-- Migration 002: Production constraints and performance indexes
-- Applied automatically by Docker Compose when the container starts.

-- -----------------------------------------------------------------------
-- CHECK CONSTRAINTS
-- -----------------------------------------------------------------------

-- Ensure a meeting cannot end before it starts
ALTER TABLE meetings
    ADD CONSTRAINT IF NOT EXISTS chk_meeting_end_after_start
    CHECK (ended_at IS NULL OR ended_at >= started_at);

-- Confidence score must be in [0, 1]
ALTER TABLE transcript_segments
    ADD CONSTRAINT IF NOT EXISTS chk_confidence_range
    CHECK (confidence >= 0.0 AND confidence <= 1.0);

-- Timestamps in milliseconds must be non-negative
ALTER TABLE transcript_segments
    ADD CONSTRAINT IF NOT EXISTS chk_timestamp_ms_positive
    CHECK (timestamp_ms >= 0);

-- -----------------------------------------------------------------------
-- PERFORMANCE INDEXES
-- -----------------------------------------------------------------------

-- List meetings for a user sorted by most recent (primary query pattern)
CREATE INDEX IF NOT EXISTS idx_meetings_user_started
    ON meetings (user_id, started_at DESC);

-- Look up active (not yet ended) meetings quickly
CREATE INDEX IF NOT EXISTS idx_meetings_active
    ON meetings (user_id)
    WHERE ended_at IS NULL;

-- Fetch transcript segments for a meeting in chronological order
CREATE INDEX IF NOT EXISTS idx_transcript_segments_meeting_ts
    ON transcript_segments (meeting_id, timestamp_ms ASC);

-- Summaries lookup by meeting_id (already has UNIQUE, but explicit for clarity)
CREATE INDEX IF NOT EXISTS idx_summaries_meeting
    ON summaries (meeting_id);

-- -----------------------------------------------------------------------
-- REFRESH TOKEN CLEANUP (background hygiene)
-- -----------------------------------------------------------------------

-- Index to speed up the "WHERE expires_at > NOW()" check on every login
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires
    ON refresh_tokens (expires_at);

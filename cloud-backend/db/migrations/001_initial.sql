-- Meetily Cloud Backend - Initial Database Schema
-- Run: psql -U meetily -d meetily -f 001_initial.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users
CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Refresh tokens (for JWT renewal)
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Meetings
CREATE TABLE IF NOT EXISTS meetings (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    platform   TEXT,                    -- 'zoom', 'microsoft_teams', 'google_meet'
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at   TIMESTAMPTZ
);

-- Transcript segments (one row per Deepgram final result)
CREATE TABLE IF NOT EXISTS transcript_segments (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    meeting_id   UUID REFERENCES meetings(id) ON DELETE CASCADE,
    text         TEXT NOT NULL,
    timestamp_ms BIGINT NOT NULL,       -- ms from meeting start
    confidence   FLOAT,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- AI summaries
CREATE TABLE IF NOT EXISTS summaries (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    meeting_id UUID UNIQUE REFERENCES meetings(id) ON DELETE CASCADE,
    content    JSONB NOT NULL,          -- { summary, action_items, key_points }
    model      TEXT NOT NULL,           -- 'claude-haiku-4-5-20251001'
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_meetings_user_id        ON meetings(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_transcript_meeting_id   ON transcript_segments(meeting_id, timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id  ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires  ON refresh_tokens(expires_at);

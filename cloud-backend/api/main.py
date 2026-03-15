"""
REST API Service — meetings, transcripts, and AI summaries.
All endpoints require a valid JWT (Authorization: Bearer <token>).
"""

import os
import uuid
from datetime import datetime, timezone
from typing import List, Optional

import json
import httpx
import jwt
from fastapi import FastAPI, HTTPException, Depends, BackgroundTasks
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

from database import get_pool, close_pool
from models import (
    CreateMeetingRequest,
    MeetingResponse,
    MeetingDetailResponse,
    TranscriptSegmentResponse,
    SummaryResponse,
)

load_dotenv()

_ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "*").split(",")

app = FastAPI(title="Meetily API Service", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

security = HTTPBearer()

JWT_SECRET = os.environ["JWT_SECRET"]
ALGORITHM = "HS256"
SUMMARY_MODEL = os.environ.get("SUMMARY_MODEL", "mistralai/Mistral-7B-Instruct-v0.2")
HF_TOKEN = os.environ.get("HF_TOKEN", "")
HF_API_URL = f"https://api-inference.huggingface.co/models/{SUMMARY_MODEL}"


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------

def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    try:
        return jwt.decode(credentials.credentials, JWT_SECRET, algorithms=[ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def startup():
    await get_pool()


@app.on_event("shutdown")
async def shutdown():
    await close_pool()


# ---------------------------------------------------------------------------
# Meeting helpers
# ---------------------------------------------------------------------------

def _row_to_meeting(row) -> MeetingResponse:
    return MeetingResponse(
        id=str(row["id"]),
        user_id=str(row["user_id"]),
        title=row["title"],
        platform=row["platform"],
        started_at=row["started_at"].isoformat(),
        ended_at=row["ended_at"].isoformat() if row["ended_at"] else None,
    )


def _row_to_segment(row) -> TranscriptSegmentResponse:
    return TranscriptSegmentResponse(
        id=str(row["id"]),
        text=row["text"],
        timestamp_ms=row["timestamp_ms"],
        confidence=row["confidence"],
        created_at=row["created_at"].isoformat(),
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/api/meetings", response_model=List[MeetingResponse])
async def list_meetings(
    limit: int = 20,
    offset: int = 0,
    user: dict = Depends(get_current_user),
):
    limit = min(limit, 100)  # never return more than 100 rows per page
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, user_id, title, platform, started_at, ended_at
            FROM meetings
            WHERE user_id = $1
            ORDER BY started_at DESC
            LIMIT $2 OFFSET $3
            """,
            user["sub"], limit, offset,
        )
    return [_row_to_meeting(r) for r in rows]


@app.post("/api/meetings", response_model=MeetingResponse, status_code=201)
async def create_meeting(
    req: CreateMeetingRequest,
    user: dict = Depends(get_current_user),
):
    meeting_id = req.meeting_id or str(uuid.uuid4())
    pool = await get_pool()

    async with pool.acquire() as conn:
        # Upsert: gateway may call this more than once for the same meeting_id
        row = await conn.fetchrow(
            """
            INSERT INTO meetings (id, user_id, title, platform)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (id) DO UPDATE
                SET title = EXCLUDED.title, platform = EXCLUDED.platform
            RETURNING id, user_id, title, platform, started_at, ended_at
            """,
            meeting_id, user["sub"], req.title, req.platform,
        )
    return _row_to_meeting(row)


@app.put("/api/meetings/{meeting_id}/end", response_model=MeetingResponse)
async def end_meeting(
    meeting_id: str,
    user: dict = Depends(get_current_user),
):
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE meetings
            SET ended_at = NOW()
            WHERE id = $1 AND user_id = $2
            RETURNING id, user_id, title, platform, started_at, ended_at
            """,
            meeting_id, user["sub"],
        )
    if not row:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return _row_to_meeting(row)


@app.get("/api/meetings/{meeting_id}", response_model=MeetingDetailResponse)
async def get_meeting(
    meeting_id: str,
    user: dict = Depends(get_current_user),
):
    pool = await get_pool()
    async with pool.acquire() as conn:
        meeting_row = await conn.fetchrow(
            """
            SELECT id, user_id, title, platform, started_at, ended_at
            FROM meetings WHERE id = $1 AND user_id = $2
            """,
            meeting_id, user["sub"],
        )
        if not meeting_row:
            raise HTTPException(status_code=404, detail="Meeting not found")

        segment_rows = await conn.fetch(
            """
            SELECT id, text, timestamp_ms, confidence, created_at
            FROM transcript_segments
            WHERE meeting_id = $1
            ORDER BY timestamp_ms ASC
            """,
            meeting_id,
        )

    return MeetingDetailResponse(
        meeting=_row_to_meeting(meeting_row),
        segments=[_row_to_segment(r) for r in segment_rows],
    )


@app.get("/api/meetings/{meeting_id}/transcript")
async def get_transcript_text(
    meeting_id: str,
    user: dict = Depends(get_current_user),
):
    """Return the full transcript as plain text, segments joined by newlines."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        meeting = await conn.fetchrow(
            "SELECT id FROM meetings WHERE id = $1 AND user_id = $2",
            meeting_id, user["sub"],
        )
        if not meeting:
            raise HTTPException(status_code=404, detail="Meeting not found")

        rows = await conn.fetch(
            "SELECT text FROM transcript_segments WHERE meeting_id = $1 ORDER BY timestamp_ms",
            meeting_id,
        )

    full_text = "\n".join(r["text"] for r in rows)
    return {"meeting_id": meeting_id, "transcript": full_text}


@app.post("/api/meetings/{meeting_id}/summarize", status_code=202)
async def trigger_summary(
    meeting_id: str,
    background_tasks: BackgroundTasks,
    user: dict = Depends(get_current_user),
):
    """Kick off async AI summary generation. Returns 202 immediately."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        meeting = await conn.fetchrow(
            "SELECT id FROM meetings WHERE id = $1 AND user_id = $2",
            meeting_id, user["sub"],
        )
        if not meeting:
            raise HTTPException(status_code=404, detail="Meeting not found")

    background_tasks.add_task(_generate_summary, meeting_id)
    return {"status": "accepted", "meeting_id": meeting_id}


@app.get("/api/meetings/{meeting_id}/summary", response_model=SummaryResponse)
async def get_summary(
    meeting_id: str,
    user: dict = Depends(get_current_user),
):
    pool = await get_pool()
    async with pool.acquire() as conn:
        # Verify ownership
        meeting = await conn.fetchrow(
            "SELECT id FROM meetings WHERE id = $1 AND user_id = $2",
            meeting_id, user["sub"],
        )
        if not meeting:
            raise HTTPException(status_code=404, detail="Meeting not found")

        row = await conn.fetchrow(
            "SELECT meeting_id, content, model, created_at FROM summaries WHERE meeting_id = $1",
            meeting_id,
        )

    if not row:
        raise HTTPException(status_code=404, detail="Summary not yet generated")

    return SummaryResponse(
        meeting_id=str(row["meeting_id"]),
        content=row["content"],
        model=row["model"],
        created_at=row["created_at"].isoformat(),
    )


@app.get("/health")
async def health():
    return {"status": "ok", "service": "api"}


# ---------------------------------------------------------------------------
# Background: AI summary generation
# ---------------------------------------------------------------------------

async def _generate_summary(meeting_id: str):
    """Fetch transcript → call HuggingFace Inference API → save to summaries table."""
    pool = await get_pool()

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT text FROM transcript_segments WHERE meeting_id = $1 ORDER BY timestamp_ms",
            meeting_id,
        )

    if not rows:
        print(f"[API] No transcript segments for meeting {meeting_id}, skipping summary")
        return

    transcript = "\n".join(r["text"] for r in rows)

    # Mistral instruct format
    prompt = (
        "<s>[INST] You are an AI meeting assistant. Analyze the following meeting transcript and respond ONLY with valid JSON "
        "containing exactly these keys: summary (string, 3-5 sentences), action_items (array of strings), key_points (array of strings).\n\n"
        f"Transcript:\n{transcript} [/INST]"
    )

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                HF_API_URL,
                headers={"Authorization": f"Bearer {HF_TOKEN}"},
                json={
                    "inputs": prompt,
                    "parameters": {
                        "max_new_tokens": 1024,
                        "return_full_text": False,
                        "temperature": 0.3,
                    },
                },
            )
            resp.raise_for_status()
            data = resp.json()

        # HF returns [{"generated_text": "..."}]
        raw = data[0]["generated_text"].strip() if isinstance(data, list) else data.get("generated_text", "")

        # Strip markdown code fences if present
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()

        content = json.loads(raw)

    except Exception as exc:
        print(f"[API] Summary generation failed for {meeting_id}: {exc}")
        return

    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO summaries (meeting_id, content, model)
            VALUES ($1, $2::jsonb, $3)
            ON CONFLICT (meeting_id) DO UPDATE
                SET content = EXCLUDED.content, model = EXCLUDED.model, created_at = NOW()
            """,
            meeting_id,
            json.dumps(content),
            SUMMARY_MODEL,
        )

    print(f"[API] Summary saved for meeting {meeting_id}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8003)

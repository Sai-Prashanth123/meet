from pydantic import BaseModel
from typing import Optional, List
import uuid


class CreateMeetingRequest(BaseModel):
    meeting_id: Optional[str] = None   # client may supply a pre-generated UUID
    title: str
    platform: Optional[str] = None


class MeetingResponse(BaseModel):
    id: str
    user_id: str
    title: str
    platform: Optional[str]
    started_at: str
    ended_at: Optional[str]


class TranscriptSegmentResponse(BaseModel):
    id: str
    text: str
    timestamp_ms: int
    confidence: Optional[float]
    created_at: str


class MeetingDetailResponse(BaseModel):
    meeting: MeetingResponse
    segments: List[TranscriptSegmentResponse]


class SummaryResponse(BaseModel):
    meeting_id: str
    content: dict       # { summary, action_items, key_points }
    model: str
    created_at: str

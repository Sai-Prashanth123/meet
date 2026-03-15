"""
STT Worker — reads audio chunks from Redis Streams, sends to Deepgram Nova-3,
writes final transcript segments to PostgreSQL, and publishes results back via
Redis pub/sub so the WebSocket gateway can forward them to the desktop client.

Production features:
- Dead Letter Queue (DLQ): messages that fail 3 times are moved to audio:dlq
- meeting_end signal: gateway publishes to audio:meeting_end when recording stops,
  prompting the worker to close the Deepgram connection for that meeting.
"""

import asyncio
import json
import os
import socket
from typing import Dict

import redis.asyncio as aioredis
from dotenv import load_dotenv

from database import get_pool, insert_transcript_segment
from deepgram_client import create_deepgram_connection, close_deepgram_connection

load_dotenv()

REDIS_URL = os.environ["REDIS_URL"]
WORKER_ID = os.environ.get("WORKER_ID", f"worker-{socket.gethostname()}")
STREAM_KEY = "audio:chunks"
CONSUMER_GROUP = "stt-workers"
DLQ_KEY = "audio:dlq"
MEETING_END_KEY = "audio:meeting_end"
MAX_RETRIES = 3

# meeting_id → (deepgram_conn, user_id)
active_connections: Dict[str, tuple] = {}


async def main():
    redis = await aioredis.from_url(REDIS_URL, decode_responses=False)
    db_pool = await get_pool()

    # Create consumer group (idempotent — ignore error if already exists)
    try:
        await redis.xgroup_create(STREAM_KEY, CONSUMER_GROUP, id="0", mkstream=True)
    except aioredis.ResponseError as exc:
        if "BUSYGROUP" not in str(exc):
            raise

    print(f"[STT Worker] {WORKER_ID} started, consuming from '{STREAM_KEY}'")

    # Run audio processing and meeting-end signal handling concurrently
    await asyncio.gather(
        consume_audio(redis, db_pool),
        consume_meeting_end(redis),
    )


async def consume_audio(redis, db_pool):
    """Main loop: read audio chunks and forward to Deepgram with DLQ protection."""
    while True:
        try:
            entries = await redis.xreadgroup(
                CONSUMER_GROUP,
                WORKER_ID,
                {STREAM_KEY: ">"},
                count=5,
                block=1000,
            )
        except Exception as exc:
            print(f"[STT Worker] Redis read error: {exc}")
            await asyncio.sleep(1)
            continue

        if not entries:
            continue

        for _stream, messages in entries:
            for msg_id, fields in messages:
                await process_with_retry(redis, db_pool, msg_id, fields)


async def consume_meeting_end(redis):
    """
    Listen to a separate Redis stream for meeting_end signals published by
    the gateway.  When received, cleanly closes the Deepgram connection for
    that meeting to free up resources immediately.
    """
    last_id = "$"  # only new messages
    while True:
        try:
            entries = await redis.xread({MEETING_END_KEY: last_id}, count=10, block=5000)
        except Exception as exc:
            print(f"[STT Worker] meeting_end stream error: {exc}")
            await asyncio.sleep(1)
            continue

        if not entries:
            continue

        for _stream, messages in entries:
            for msg_id, fields in messages:
                last_id = msg_id
                meeting_id = fields.get(b"meeting_id", b"").decode()
                if meeting_id and meeting_id in active_connections:
                    conn, _ = active_connections.pop(meeting_id)
                    await close_deepgram_connection(conn)
                    print(f"[STT Worker] Deepgram connection closed for meeting {meeting_id}")


async def process_with_retry(redis, db_pool, msg_id, fields: dict):
    """Process an audio chunk; on failure, retry up to MAX_RETRIES then move to DLQ."""
    retry_count = int(fields.get(b"_retry", b"0"))
    try:
        await process_chunk(redis, db_pool, fields)
        await redis.xack(STREAM_KEY, CONSUMER_GROUP, msg_id)
    except Exception as exc:
        if retry_count >= MAX_RETRIES:
            # Move to Dead Letter Queue for manual inspection
            dlq_fields = dict(fields)
            dlq_fields[b"_error"] = str(exc).encode()
            dlq_fields[b"_original_id"] = str(msg_id).encode()
            await redis.xadd(DLQ_KEY, dlq_fields)
            await redis.xack(STREAM_KEY, CONSUMER_GROUP, msg_id)
            print(f"[STT Worker] [DLQ] Message {msg_id} moved to {DLQ_KEY} after {MAX_RETRIES} retries: {exc}")
        else:
            # Re-queue with incremented retry counter
            retry_fields = dict(fields)
            retry_fields[b"_retry"] = str(retry_count + 1).encode()
            await redis.xadd(STREAM_KEY, retry_fields)
            await redis.xack(STREAM_KEY, CONSUMER_GROUP, msg_id)
            print(f"[STT Worker] Retrying message {msg_id} (attempt {retry_count + 1}/{MAX_RETRIES}): {exc}")


async def process_chunk(redis, db_pool, fields: dict):
    meeting_id = fields[b"meeting_id"].decode()
    user_id = fields[b"user_id"].decode()
    audio: bytes = fields[b"audio"]

    # Get or create Deepgram connection for this meeting
    if meeting_id not in active_connections:
        print(f"[STT Worker] Opening Deepgram connection for meeting {meeting_id}")
        conn = await create_deepgram_connection(
            meeting_id,
            on_transcript=make_transcript_handler(redis, db_pool, user_id),
        )
        active_connections[meeting_id] = (conn, user_id)

    conn, _ = active_connections[meeting_id]
    await conn.send(audio)


def make_transcript_handler(redis, db_pool, user_id: str):
    async def on_transcript(meeting_id: str, text: str, timestamp_ms: int, confidence: float):
        # 1. Persist to PostgreSQL
        await insert_transcript_segment(db_pool, meeting_id, text, timestamp_ms, confidence)

        # 2. Publish to Redis pub/sub so the gateway forwards it to the desktop
        message = json.dumps({
            "type": "transcript",
            "meeting_id": meeting_id,
            "text": text,
            "timestamp_ms": timestamp_ms,
            "is_final": True,
        })
        await redis.publish(f"transcript:{user_id}", message)

        print(f"[STT Worker] [{meeting_id}] {text[:80]}")

    return on_transcript


if __name__ == "__main__":
    asyncio.run(main())

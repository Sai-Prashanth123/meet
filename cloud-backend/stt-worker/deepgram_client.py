import asyncio
import json
import os
from typing import Callable, Awaitable

from deepgram import (
    DeepgramClient,
    LiveTranscriptionEvents,
    LiveOptions,
)


async def create_deepgram_connection(
    meeting_id: str,
    on_transcript: Callable[[str, str, int, float], Awaitable[None]],
) -> object:
    """
    Open a Deepgram Nova-3 streaming WebSocket for a single meeting.

    on_transcript(meeting_id, text, timestamp_ms, confidence) is called
    for every final transcript segment.

    A KeepAlive task is started automatically to prevent the Deepgram
    connection from timing out after 12 seconds of silence.
    """
    api_key = os.environ["DEEPGRAM_API_KEY"]
    client = DeepgramClient(api_key)
    conn = client.listen.asynclive.v("1")

    async def _on_transcript(result, **kwargs):
        try:
            alt = result.channel.alternatives[0]
            if result.is_final and alt.transcript.strip():
                timestamp_ms = int(result.start * 1000)
                await on_transcript(meeting_id, alt.transcript, timestamp_ms, alt.confidence)
        except Exception as exc:
            print(f"[Deepgram] Transcript handler error for {meeting_id}: {exc}")

    conn.on(LiveTranscriptionEvents.Transcript, _on_transcript)

    options = LiveOptions(
        model="nova-3",
        language="en-US",
        encoding="linear16",
        sample_rate=16000,
        channels=1,
        punctuate=True,
        interim_results=False,  # only final results to reduce DB writes
    )
    await conn.start(options)

    # KeepAlive task — Deepgram closes idle connections after ~12 s.
    # Sending a KeepAlive frame every 5 s keeps the connection alive during
    # silences without counting as audio.
    async def _keepalive_task():
        while True:
            await asyncio.sleep(5)
            try:
                await conn.keep_alive()
            except Exception:
                break  # Connection already closed; stop silently

    keepalive = asyncio.create_task(_keepalive_task())
    conn._keepalive_task = keepalive  # store reference so it can be cancelled on close

    return conn


async def close_deepgram_connection(conn) -> None:
    """Cleanly shut down a Deepgram streaming connection and its KeepAlive task."""
    # Cancel the periodic KeepAlive task first
    task = getattr(conn, "_keepalive_task", None)
    if task and not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    try:
        await conn.finish()
    except Exception as exc:
        print(f"[Deepgram] Error closing connection: {exc}")

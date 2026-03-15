import os
import asyncpg
from typing import Optional

_pool: Optional[asyncpg.Pool] = None


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        dsn = os.environ["DATABASE_URL"].split("?")[0]
        use_ssl = "supabase.co" in dsn or "pooler.supabase.com" in dsn
        _pool = await asyncpg.create_pool(
            dsn=dsn,
            ssl="require" if use_ssl else None,
            min_size=2,
            max_size=10,
        )
    return _pool


async def close_pool():
    global _pool
    if _pool:
        await _pool.close()
        _pool = None


async def insert_transcript_segment(
    pool: asyncpg.Pool,
    meeting_id: str,
    text: str,
    timestamp_ms: int,
    confidence: float,
) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO transcript_segments (meeting_id, text, timestamp_ms, confidence)
            VALUES ($1, $2, $3, $4)
            """,
            meeting_id, text, timestamp_ms, confidence,
        )

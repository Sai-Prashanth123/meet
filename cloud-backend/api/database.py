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

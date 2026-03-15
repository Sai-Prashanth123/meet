# Meetily Cloud Backend

Real-time meeting transcription and storage backend for the Meetily desktop app.

## Architecture

```
Desktop App (Tauri)
    │  wss://gateway:8002/stream?token=<JWT>
    ▼
WebSocket Gateway (Node.js, port 8002)
    │  publishes to Redis Streams "audio:chunks"
    ▼
Redis Streams
    │  consumed by STT Worker
    ▼
STT Worker (Python)
    │  Deepgram Nova-3 streaming WebSocket
    │  saves to PostgreSQL
    │  publishes to Redis pub/sub "transcript:{user_id}"
    ▼
Gateway → Desktop (real-time transcript)

Desktop → REST API (port 8003) → PostgreSQL
    - list meetings
    - get transcript
    - trigger/get AI summary (Claude)
```

## Services

| Service | Tech | Port | Purpose |
|---|---|---|---|
| `auth` | FastAPI + Python | 8001 | Register, login, JWT |
| `gateway` | Node.js + ws | 8002 | WebSocket audio receiver |
| `stt-worker` | Python + Deepgram | — | Transcription worker |
| `api` | FastAPI + Python | 8003 | REST API (meetings, transcripts, summaries) |

## Quick Start

### Prerequisites
- Docker + Docker Compose
- Deepgram API key (from [deepgram.com](https://deepgram.com))
- Anthropic API key (from [anthropic.com](https://anthropic.com)) — for summaries

### 1. Set environment variables

```bash
cp auth/.env.example auth/.env
cp gateway/.env.example gateway/.env
cp stt-worker/.env.example stt-worker/.env
cp api/.env.example api/.env

# Or set in shell for docker-compose:
export DEEPGRAM_API_KEY=your_key_here
export ANTHROPIC_API_KEY=your_key_here
export JWT_SECRET=a_strong_random_secret_at_least_32_chars
```

### 2. Start all services

```bash
cd cloud-backend
docker-compose up --build
```

Services start in order: postgres → redis → auth + api → gateway → stt-worker

### 3. Test auth

```bash
# Register
curl -X POST http://localhost:8001/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"secret123"}'

# Login
curl -X POST http://localhost:8001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"secret123"}'
```

### 4. Test WebSocket gateway

```bash
# Install wscat: npm install -g wscat
TOKEN="<paste token from login>"
wscat -c "ws://localhost:8002/stream?token=$TOKEN"
# Type: {"type":"start_meeting","meeting_id":"550e8400-e29b-41d4-a716-446655440000","title":"Test","platform":"zoom"}
```

### 5. Test REST API

```bash
TOKEN="<paste token>"
curl -H "Authorization: Bearer $TOKEN" http://localhost:8003/api/meetings
```

## Database Schema

See [`db/migrations/001_initial.sql`](db/migrations/001_initial.sql) for the full PostgreSQL schema.

Tables:
- `users` — accounts
- `refresh_tokens` — JWT refresh tokens
- `meetings` — meeting records (title, platform, start/end times)
- `transcript_segments` — one row per Deepgram final result
- `summaries` — Claude-generated summaries (JSONB)

## Desktop App Integration

### Enable Cloud Mode

In the Meetily desktop app, go to **Settings → Beta Features** and enable **Cloud Mode**.

On first use, a login screen appears. After login, the JWT is stored in localStorage and auto-refreshed.

### Audio Frame Protocol (Desktop → Gateway)

Binary frames:
```
[4 bytes LE: meeting_id UTF-8 length][meeting_id bytes][PCM16 mono 16kHz audio]
```

Control frames (JSON text):
```json
{ "type": "start_meeting", "meeting_id": "uuid", "title": "...", "platform": "zoom" }
{ "type": "end_meeting", "meeting_id": "uuid" }
```

### Environment Variables for Frontend

```
NEXT_PUBLIC_AUTH_URL=http://localhost:8001
NEXT_PUBLIC_API_URL=http://localhost:8003
NEXT_PUBLIC_GATEWAY_URL=ws://localhost:8002
```

## Scaling

- **Gateway**: Run 4 instances behind nginx for 10k concurrent users (Node.js handles ~2500 WS connections per process)
- **STT Workers**: 1 worker per ~50 concurrent meetings; scale horizontally via Docker Swarm or Kubernetes
- **Auth/API**: Stateless FastAPI; scale with multiple replicas behind a load balancer

## Development

Run individual services without Docker:

```bash
# Auth
cd auth && pip install -r requirements.txt && uvicorn main:app --port 8001 --reload

# Gateway
cd gateway && npm install && node server.js

# STT Worker
cd stt-worker && pip install -r requirements.txt && python worker.py

# API
cd api && pip install -r requirements.txt && uvicorn main:app --port 8003 --reload
```

Requires PostgreSQL on port 5432 and Redis on port 6379 (use `docker-compose up postgres redis`).

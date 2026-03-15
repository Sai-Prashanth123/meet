'use strict';

require('dotenv').config();

const WebSocket = require('ws');
const { verifyJWT } = require('./auth');
const { publishAudioChunk, subscribeUserTranscripts, connect: redisConnect } = require('./redis');

const PORT = parseInt(process.env.PORT || '8002', 10);
const API_SERVICE_URL = process.env.API_SERVICE_URL || 'http://api:8003';

// Dynamic import for node-fetch (ESM module)
let fetchFn;
async function getFetch() {
  if (!fetchFn) {
    const mod = await import('node-fetch');
    fetchFn = mod.default;
  }
  return fetchFn;
}

async function apiRequest(method, path, body, token) {
  const fetch = await getFetch();
  const res = await fetch(`${API_SERVICE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function main() {
  await redisConnect();
  console.log('[Gateway] Redis connected');

  const wss = new WebSocket.Server({ port: PORT });
  console.log(`[Gateway] WebSocket server listening on port ${PORT}`);

  // ---------- Heartbeat: detect dead connections every 30s ----------
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        console.log('[Gateway] Terminating unresponsive connection');
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);

  wss.on('close', () => clearInterval(heartbeatInterval));

  wss.on('connection', (ws) => {
    // Mark alive for heartbeat
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // Per-connection state: starts unauthenticated
    const state = {
      authenticated: false,
      user_id: null,
      meeting_id: null,
      token: null,
    };

    // Populated after successful auth
    let unsubscribe = null;

    // ---------- Message handler ----------
    ws.on('message', async (data, isBinary) => {
      try {
        // ---- Pre-auth: only accept the "auth" control frame ----
        if (!state.authenticated) {
          if (isBinary) {
            ws.close(4001, 'Auth required before sending audio');
            return;
          }

          const msg = JSON.parse(data.toString());

          if (msg.type !== 'auth') {
            ws.close(4001, 'First message must be {type:"auth",token:"..."}');
            return;
          }

          const payload = verifyJWT(msg.token);
          if (!payload) {
            ws.close(4001, 'Unauthorized');
            return;
          }

          state.authenticated = true;
          state.user_id = payload.sub;
          state.token = msg.token;

          // Subscribe to this user's transcript channel now that we know who they are
          unsubscribe = subscribeUserTranscripts(state.user_id, (transcript) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(transcript));
            }
          });

          console.log(`[Gateway] User authenticated: ${state.user_id}`);
          ws.send(JSON.stringify({ type: 'auth_ok', user_id: state.user_id }));
          return;
        }

        // ---- Post-auth message handling ----
        if (!isBinary) {
          // JSON control frame
          const msg = JSON.parse(data.toString());

          if (msg.type === 'start_meeting') {
            state.meeting_id = msg.meeting_id;
            await apiRequest(
              'POST',
              '/api/meetings',
              {
                meeting_id: msg.meeting_id,
                title: msg.title || 'Untitled Meeting',
                platform: msg.platform || null,
              },
              state.token
            );
            console.log(`[Gateway] Meeting started: ${msg.meeting_id} for user ${state.user_id}`);
          } else if (msg.type === 'end_meeting') {
            if (state.meeting_id) {
              await apiRequest(
                'PUT',
                `/api/meetings/${state.meeting_id}/end`,
                {},
                state.token
              );
              console.log(`[Gateway] Meeting ended: ${state.meeting_id}`);
            }
            state.meeting_id = null;
          }
        } else {
          // Binary audio frame:
          // [4 bytes LE: meeting_id length][meeting_id UTF-8][PCM16 audio bytes]
          if (!state.meeting_id) return;

          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          if (buf.length < 4) return;

          const idLen = buf.readUInt32LE(0);
          if (buf.length < 4 + idLen) return;

          const meeting_id = buf.slice(4, 4 + idLen).toString('utf8');
          const audio = buf.slice(4 + idLen);

          await publishAudioChunk({
            user_id: state.user_id,
            meeting_id,
            audio,
            timestamp_ms: Date.now(),
          });
        }
      } catch (err) {
        console.error(`[Gateway] Error processing message for ${state.user_id}:`, err.message);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', code: 'processing_error', message: err.message }));
        }
      }
    });

    // ---------- Disconnect handler ----------
    ws.on('close', () => {
      console.log(`[Gateway] User disconnected: ${state.user_id || 'unauthenticated'}`);
      if (unsubscribe) unsubscribe();
    });

    ws.on('error', (err) => {
      console.error(`[Gateway] WebSocket error for ${state.user_id || 'unauthenticated'}:`, err.message);
      if (unsubscribe) unsubscribe();
    });
  });
}

main().catch((err) => {
  console.error('[Gateway] Fatal startup error:', err);
  process.exit(1);
});

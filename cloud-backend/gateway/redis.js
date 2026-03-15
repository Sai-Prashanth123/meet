'use strict';

const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Publisher client — for xadd (audio stream) and publish (transcript pub/sub)
const publisher = new Redis(REDIS_URL, { lazyConnect: true });

// Separate subscriber client — ioredis requires a dedicated connection for subscribe
const _subscribers = new Map(); // user_id → Redis subscriber instance

publisher.on('error', (err) => console.error('[Redis publisher]', err.message));

/**
 * Publish a raw audio chunk to the Redis Stream "audio:chunks".
 * The STT worker reads from this stream using XREADGROUP.
 *
 * @param {object} chunk - { user_id, meeting_id, audio: Buffer, timestamp_ms }
 */
async function publishAudioChunk({ user_id, meeting_id, audio, timestamp_ms }) {
  await publisher.xadd(
    'audio:chunks',
    '*',               // auto-generate stream ID
    'user_id', user_id,
    'meeting_id', meeting_id,
    'audio', audio,    // Buffer stored as bytes
    'timestamp_ms', String(timestamp_ms)
  );
}

/**
 * Subscribe to the Redis pub/sub channel "transcript:{user_id}".
 * Each published message is passed to the callback as a parsed object.
 *
 * @param {string} user_id
 * @param {function} callback - (parsedMessage) => void
 * @returns {function} unsubscribe - call to stop listening
 */
function subscribeUserTranscripts(user_id, callback) {
  const channel = `transcript:${user_id}`;

  const sub = new Redis(REDIS_URL, { lazyConnect: true });
  sub.on('error', (err) => console.error(`[Redis sub:${user_id}]`, err.message));

  sub.subscribe(channel);
  sub.on('message', (ch, message) => {
    if (ch !== channel) return;
    try {
      callback(JSON.parse(message));
    } catch {
      // ignore malformed messages
    }
  });

  _subscribers.set(user_id, sub);

  return function unsubscribe() {
    sub.unsubscribe(channel);
    sub.disconnect();
    _subscribers.delete(user_id);
  };
}

async function connect() {
  await publisher.connect();
}

module.exports = { publishAudioChunk, subscribeUserTranscripts, connect };

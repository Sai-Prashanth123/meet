/**
 * cloudMeetingService.ts — Fetches meetings, transcripts, and summaries from
 * the cloud REST API (port 8003).
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8003';

export interface CloudMeeting {
  id: string;
  user_id: string;
  title: string;
  platform: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface TranscriptSegment {
  id: string;
  text: string;
  timestamp_ms: number;
  confidence: number | null;
  created_at: string;
}

export interface MeetingDetail {
  meeting: CloudMeeting;
  segments: TranscriptSegment[];
}

export interface MeetingSummary {
  meeting_id: string;
  content: {
    summary: string;
    action_items: string[];
    key_points: string[];
  };
  model: string;
  created_at: string;
}

async function apiGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `API error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function apiPost<T>(path: string, token: string, body?: object): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `API error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function listMeetings(
  token: string,
  limit = 20,
  offset = 0
): Promise<CloudMeeting[]> {
  return apiGet<CloudMeeting[]>(
    `/api/meetings?limit=${limit}&offset=${offset}`,
    token
  );
}

export async function getMeeting(token: string, meetingId: string): Promise<MeetingDetail> {
  return apiGet<MeetingDetail>(`/api/meetings/${meetingId}`, token);
}

export async function createMeeting(
  token: string,
  payload: { meeting_id?: string; title: string; platform?: string }
): Promise<CloudMeeting> {
  return apiPost<CloudMeeting>('/api/meetings', token, payload);
}

export async function endMeeting(token: string, meetingId: string): Promise<CloudMeeting> {
  const res = await fetch(`${API_BASE_URL}/api/meetings/${meetingId}/end`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to end meeting: ${res.status}`);
  return res.json() as Promise<CloudMeeting>;
}

export async function getTranscriptText(
  token: string,
  meetingId: string
): Promise<{ meeting_id: string; transcript: string }> {
  return apiGet(`/api/meetings/${meetingId}/transcript`, token);
}

export async function triggerSummary(token: string, meetingId: string): Promise<void> {
  await apiPost(`/api/meetings/${meetingId}/summarize`, token);
}

export async function getSummary(
  token: string,
  meetingId: string
): Promise<MeetingSummary> {
  return apiGet<MeetingSummary>(`/api/meetings/${meetingId}/summary`, token);
}

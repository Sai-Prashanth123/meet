/**
 * authService.ts — Cloud auth operations (register, login, refresh, logout).
 * Calls the Auth service running on port 8001.
 */

const AUTH_BASE_URL = process.env.NEXT_PUBLIC_AUTH_URL || 'http://localhost:8001';

export interface AuthTokens {
  user_id: string;
  token: string;
  refresh_token: string;
}

export interface UserProfile {
  user_id: string;
  email: string;
  created_at: string;
}

async function post<T>(path: string, body: object, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${AUTH_BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Auth error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function register(email: string, password: string): Promise<AuthTokens> {
  return post<AuthTokens>('/auth/register', { email, password });
}

export async function login(email: string, password: string): Promise<AuthTokens> {
  return post<AuthTokens>('/auth/login', { email, password });
}

export async function refreshToken(refresh_token: string): Promise<string> {
  const res = await post<{ token: string }>('/auth/refresh', { refresh_token });
  return res.token;
}

export async function getMe(token: string): Promise<UserProfile> {
  const res = await fetch(`${AUTH_BASE_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Failed to fetch user profile');
  return res.json() as Promise<UserProfile>;
}

export function logout(): void {
  localStorage.removeItem('cloud_token');
  localStorage.removeItem('cloud_refresh_token');
  localStorage.removeItem('cloud_user_id');
}

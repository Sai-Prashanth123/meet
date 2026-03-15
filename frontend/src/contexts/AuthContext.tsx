'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { login, register, logout, refreshToken, getMe } from '@/services/authService';
import type { UserProfile } from '@/services/authService';

interface AuthState {
  userId: string | null;
  token: string | null;
  user: UserProfile | null;
  isLoading: boolean;
}

interface AuthContextValue extends AuthState {
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const TOKEN_KEY = 'cloud_token';
const REFRESH_KEY = 'cloud_refresh_token';
const USER_ID_KEY = 'cloud_user_id';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    userId: null,
    token: null,
    user: null,
    isLoading: true,
  });

  // Mutex flag: prevents concurrent refresh calls from racing each other.
  // Without this, two near-simultaneous 401s could each call refreshToken(),
  // the second would succeed with a now-invalid refresh token, and both would
  // store different access tokens leading to inconsistent state.
  const isRefreshingRef = React.useRef(false);

  // On mount: restore token from localStorage and validate/refresh it
  useEffect(() => {
    async function restoreSession() {
      const token = localStorage.getItem(TOKEN_KEY);
      const refresh = localStorage.getItem(REFRESH_KEY);
      const userId = localStorage.getItem(USER_ID_KEY);

      if (!token || !userId) {
        setState((s) => ({ ...s, isLoading: false }));
        return;
      }

      try {
        // Try to fetch user profile — if token expired, refresh first
        let activeToken = token;
        let profile: UserProfile;
        try {
          profile = await getMe(activeToken);
        } catch {
          if (!refresh) throw new Error('No refresh token');
          activeToken = await refreshToken(refresh);
          localStorage.setItem(TOKEN_KEY, activeToken);
          profile = await getMe(activeToken);
        }

        setState({ userId, token: activeToken, user: profile, isLoading: false });
      } catch {
        // Session invalid — clear it
        logout();
        setState({ userId: null, token: null, user: null, isLoading: false });
      }
    }

    restoreSession();
  }, []);

  // Auto-refresh access token 5 minutes before expiry.
  // Uses isRefreshingRef to prevent concurrent refreshes from racing.
  useEffect(() => {
    if (!state.token) return;

    let timeoutId: ReturnType<typeof setTimeout>;

    try {
      const payload = JSON.parse(atob(state.token.split('.')[1]));
      const expiresAt = payload.exp * 1000;
      const refreshAt = expiresAt - 5 * 60 * 1000;
      const delay = refreshAt - Date.now();

      if (delay > 0) {
        timeoutId = setTimeout(async () => {
          // Guard against concurrent refresh attempts
          if (isRefreshingRef.current) return;
          isRefreshingRef.current = true;

          const refresh = localStorage.getItem(REFRESH_KEY);
          if (!refresh) {
            isRefreshingRef.current = false;
            return;
          }
          try {
            const newToken = await refreshToken(refresh);
            localStorage.setItem(TOKEN_KEY, newToken);
            setState((s) => ({ ...s, token: newToken }));
          } catch {
            signOut();
          } finally {
            isRefreshingRef.current = false;
          }
        }, delay);
      }
    } catch {
      // Non-critical — JWT parse failed, skip auto-refresh
    }

    return () => clearTimeout(timeoutId);
  }, [state.token]);

  const signIn = useCallback(async (email: string, password: string) => {
    const tokens = await login(email, password);
    localStorage.setItem(TOKEN_KEY, tokens.token);
    localStorage.setItem(REFRESH_KEY, tokens.refresh_token);
    localStorage.setItem(USER_ID_KEY, tokens.user_id);
    const profile = await getMe(tokens.token);
    setState({ userId: tokens.user_id, token: tokens.token, user: profile, isLoading: false });
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    const tokens = await register(email, password);
    localStorage.setItem(TOKEN_KEY, tokens.token);
    localStorage.setItem(REFRESH_KEY, tokens.refresh_token);
    localStorage.setItem(USER_ID_KEY, tokens.user_id);
    const profile = await getMe(tokens.token);
    setState({ userId: tokens.user_id, token: tokens.token, user: profile, isLoading: false });
  }, []);

  const signOut = useCallback(() => {
    logout();
    setState({ userId: null, token: null, user: null, isLoading: false });
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

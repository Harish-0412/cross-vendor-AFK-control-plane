// frontend/lib/auth.ts
// Zustand auth store with auth provider selection, Control Plane integration, and silent refresh.
//
// Auth providers:
//   - "local":    email/password against the Control Plane's own JWT auth (works without Firebase admin credentials)
//   - "firebase": Firebase Authentication (requires the Control Plane to have a Firebase service account to verify ID tokens)
//   - "auto":     Firebase when NEXT_PUBLIC_FIREBASE_* keys are present, otherwise local
//
// Set NEXT_PUBLIC_AUTH_PROVIDER=local in .env.local when the Control Plane cannot verify
// Firebase ID tokens (i.e. no GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_CLIENT_EMAIL /
// FIREBASE_PRIVATE_KEY on the server side).

import { create } from 'zustand';
import type { User as FirebaseUser } from 'firebase/auth';
import { apiClient, setAccessToken, setOnAuthFailure, ApiError } from './api-client';
import {
  isFirebaseConfigured,
  loginWithEmail as fbLoginWithEmail,
  registerWithEmail as fbRegisterWithEmail,
  loginWithGoogle as fbLoginWithGoogle,
  logoutFirebase as fbLogout,
  getCurrentIdToken,
  auth as fbAuth,
} from './firebase';

type AuthProvider = 'local' | 'firebase' | 'auto';

function resolveAuthProvider(): AuthProvider {
  const env = (process.env.NEXT_PUBLIC_AUTH_PROVIDER || 'auto').toLowerCase();
  if (env === 'local' || env === 'firebase') return env;
  return isFirebaseConfigured ? 'firebase' : 'local';
}

const authProvider = resolveAuthProvider();
const useFirebase = authProvider === 'firebase';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  /** 'owner' is assigned server-side and returned by /auth/me. */
  role: 'user' | 'admin' | 'owner';
  photoURL?: string | null;
}

const AUTH_COOKIE = 'auth_token';
const AUTH_COOKIE_MAX_AGE = 2592000; // 30 days

export function setAuthCookie(_token: string): void {
  // Middleware gate: presence of this cookie lets authenticated users through.
  // Real authorization happens via the Bearer access token on API calls.
  if (typeof document !== 'undefined') {
    document.cookie = `${AUTH_COOKIE}=1; path=/; max-age=${AUTH_COOKIE_MAX_AGE}; SameSite=Lax`;
  }
}

export function clearAuthCookie(): void {
  if (typeof document !== 'undefined') {
    document.cookie = `${AUTH_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
  }
}

interface AuthResponse {
  accessToken: string;
  refreshToken?: string;
  user: AuthUser;
}

interface MeResponse {
  user: AuthUser;
  deviceCount: number;
  connectedDeviceCount: number;
}

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isInitialized: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  register: (email: string, password: string, name?: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  /** Force a Firebase token refresh and re-read the server-authoritative role. */
  refreshFirebaseRole: () => Promise<void>;
  clearError: () => void;
}

function firebaseFallbackUser(user: FirebaseUser): AuthUser {
  return {
    id: user.uid,
    email: user.email || '',
    name: user.displayName || user.email?.split('@')[0] || 'User',
    role: 'user',
    photoURL: user.photoURL,
  };
}

async function resolveFirebaseProfile(
  user: FirebaseUser,
  token: string,
): Promise<AuthUser> {
  setAccessToken(token);
  setAuthCookie(token);
  try {
    const me = await apiClient.get<MeResponse>('/api/v1/auth/me');
    return { ...me.user, photoURL: user.photoURL };
  } catch {
    // Authentication itself is still useful while the Control Plane wakes;
    // privileged routes will independently require the server response.
    return firebaseFallbackUser(user);
  }
}

function formatAuthError(err: unknown, fallback: string): string {
  // The hosted Control Plane sleeps when idle and takes about a minute to
  // wake. The proxy gives up first and answers 502/503/504 — which used to
  // surface as "Request failed with status 504" and read like a broken
  // sign-up form. Say what is actually happening.
  if (err instanceof ApiError && [502, 503, 504].includes(err.status)) {
    return 'The server is waking up — free hosting sleeps when idle. Give it a few seconds and try again.';
  }
  if (err instanceof TypeError) {
    // fetch rejects with TypeError when the network itself failed.
    return 'Could not reach the server. Check your connection and try again.';
  }
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: string }).code || '';
    const msg = (err as { message?: string }).message || '';

    if (code === 'auth/email-already-in-use' || msg.includes('auth/email-already-in-use') || msg.includes('EMAIL_EXISTS')) {
      return 'This email is already registered. Please sign in instead.';
    }
    if (code === 'auth/weak-password' || msg.includes('auth/weak-password') || msg.includes('WEAK_PASSWORD')) {
      return 'Password must be at least 6 characters long.';
    }
    if (code === 'auth/invalid-email' || msg.includes('auth/invalid-email') || msg.includes('INVALID_EMAIL')) {
      return 'Please enter a valid email address.';
    }
    if (code === 'auth/invalid-credential' || msg.includes('auth/invalid-credential') || msg.includes('INVALID_LOGIN_CREDENTIALS')) {
      return 'Invalid email or password.';
    }
    if (code === 'auth/user-not-found' || msg.includes('auth/user-not-found')) {
      return 'No account found with this email.';
    }
    if (code === 'auth/wrong-password' || msg.includes('auth/wrong-password')) {
      return 'Incorrect password. Please try again.';
    }
    if (code === 'auth/too-many-requests' || msg.includes('auth/too-many-requests')) {
      return 'Too many attempts. Please wait a moment and try again.';
    }
    if (code === 'auth/popup-closed-by-user' || msg.includes('auth/popup-closed-by-user')) {
      return 'Google sign in was closed before completing.';
    }
    if (msg) return msg;
  }
  if (err instanceof ApiError) return err.message;
  return fallback;
}

export const useAuthStore = create<AuthState>((set, get) => {
  // Wire up auth failure callback from apiClient to logout cleanly
  setOnAuthFailure(() => {
    clearAuthCookie();
    set({
      user: null,
      accessToken: null,
      isAuthenticated: false,
      isLoading: false,
    });
  });

  return {
    user: null,
    accessToken: null,
    isAuthenticated: false,
    isLoading: false,
    isInitialized: false,
    error: null,

    clearError: () => set({ error: null }),

    login: async (email: string, password: string) => {
      set({ isLoading: true, error: null });
      try {
        if (useFirebase) {
          const { user, idToken } = await fbLoginWithEmail(email, password);
          const profile = await resolveFirebaseProfile(user, idToken);
          set({
            user: profile,
            accessToken: idToken,
            isAuthenticated: true,
            isLoading: false,
            error: null,
          });
        } else {
          const data = await apiClient.post<AuthResponse>('/api/v1/auth/login', {
            email,
            password,
          });

          setAccessToken(data.accessToken);
          setAuthCookie(data.accessToken);
          set({
            user: data.user,
            accessToken: data.accessToken,
            isAuthenticated: true,
            isLoading: false,
            error: null,
          });
        }
      } catch (err) {
        const message = formatAuthError(err, 'Invalid email or password');
        set({ isLoading: false, error: message });
        throw new Error(message);
      }
    },

    loginWithGoogle: async () => {
      if (!useFirebase) {
        set({ error: 'Google sign-in requires the firebase auth provider. Use email and password instead.' });
        throw new Error('Google sign-in requires the firebase auth provider');
      }
      set({ isLoading: true, error: null });
      try {
        const { user, idToken } = await fbLoginWithGoogle();
        const profile = await resolveFirebaseProfile(user, idToken);
        set({
          user: profile,
          accessToken: idToken,
          isAuthenticated: true,
          isLoading: false,
          error: null,
        });
      } catch (err) {
        const message = formatAuthError(err, 'Google sign in failed');
        set({ isLoading: false, error: message });
        throw new Error(message);
      }
    },

    register: async (email: string, password: string, name?: string) => {
      set({ isLoading: true, error: null });
      try {
        if (useFirebase) {
          const { user, idToken } = await fbRegisterWithEmail(email, password, name);
          const profile = await resolveFirebaseProfile(user, idToken);
          set({
            user: profile,
            accessToken: idToken,
            isAuthenticated: true,
            isLoading: false,
            error: null,
          });
        } else {
          const data = await apiClient.post<AuthResponse>('/api/v1/auth/register', {
            email,
            password,
            name,
          });

          setAccessToken(data.accessToken);
          setAuthCookie(data.accessToken);
          set({
            user: data.user,
            accessToken: data.accessToken,
            isAuthenticated: true,
            isLoading: false,
            error: null,
          });
        }
      } catch (err) {
        const message = formatAuthError(err, 'Failed to create account');
        set({ isLoading: false, error: message });
        throw new Error(message);
      }
    },

    logout: async () => {
      try {
        if (useFirebase) {
          await fbLogout();
        }
        await apiClient.post('/api/v1/auth/logout', {});
      } catch {
        /* best effort */
      } finally {
        setAccessToken(null);
        clearAuthCookie();
        set({
          user: null,
          accessToken: null,
          isAuthenticated: false,
          isLoading: false,
          error: null,
        });
      }
    },

    checkAuth: async () => {
      set({ isLoading: true });
      try {
        // Firebase path: rely on the persisted Firebase session
        if (useFirebase && fbAuth?.currentUser) {
          const token = await getCurrentIdToken();
          if (token) {
            const fbUser = fbAuth.currentUser;
            const profile = await resolveFirebaseProfile(fbUser, token);
            set({
              user: profile,
              accessToken: token,
              isAuthenticated: true,
              isLoading: false,
              isInitialized: true,
              error: null,
            });
            return;
          }
        }

        // Local path: silent refresh using HttpOnly cookie on Control Plane
        const refreshData = await apiClient.post<{ accessToken: string }>(
          '/api/v1/auth/refresh',
          {},
        );

        if (refreshData.accessToken) {
          setAccessToken(refreshData.accessToken);
          setAuthCookie(refreshData.accessToken);
          // Fetch current user details — /api/v1/auth/me returns { user, deviceCount, connectedDeviceCount }
          const meData = await apiClient.get<MeResponse>('/api/v1/auth/me');
          set({
            user: meData.user,
            accessToken: refreshData.accessToken,
            isAuthenticated: true,
            isLoading: false,
            isInitialized: true,
            error: null,
          });
          return;
        }

        clearAuthCookie();
        set({
          user: null,
          accessToken: null,
          isAuthenticated: false,
          isLoading: false,
          isInitialized: true,
        });
      } catch {
        setAccessToken(null);
        clearAuthCookie();
        set({
          user: null,
          accessToken: null,
          isAuthenticated: false,
          isLoading: false,
          isInitialized: true,
        });
      }
    },

    refreshFirebaseRole: async () => {
      const firebaseUser = fbAuth?.currentUser;
      if (!useFirebase || !firebaseUser) return;
      const token = await getCurrentIdToken(true);
      if (!token) return;
      const profile = await resolveFirebaseProfile(firebaseUser, token);
      set({
        user: profile,
        accessToken: token,
        isAuthenticated: true,
        isInitialized: true,
        error: null,
      });
    },
  };
});

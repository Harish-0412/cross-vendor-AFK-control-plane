// frontend/lib/firebase.ts
// Firebase client SDK integration: Authentication (Server-side Firestore persistence mediated via Control Plane)

import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  type Auth,
  type User as FirebaseUser,
  type UserCredential,
} from 'firebase/auth';
import { apiClient, setAccessToken } from './api-client';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || '',
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || '',
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || '',
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || '',
};

export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId,
);

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let googleProvider: GoogleAuthProvider | null = null;

if (typeof window !== 'undefined' || isFirebaseConfigured) {
  try {
    if (!getApps().length) {
      if (isFirebaseConfigured) {
        app = initializeApp(firebaseConfig);
      }
    } else {
      app = getApp();
    }

    if (app) {
      auth = getAuth(app);
      googleProvider = new GoogleAuthProvider();
      googleProvider.setCustomParameters({ prompt: 'select_account' });
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[Firebase] Error initializing Firebase client:', error);
  }
}

export { app, auth, googleProvider };

export interface UserProfileData {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  role: 'user' | 'admin';
}

function setClientAuthCookie(): void {
  if (typeof document !== 'undefined') {
    document.cookie = 'auth_token=1; path=/; max-age=2592000; SameSite=Lax';
  }
}

function clearClientAuthCookie(): void {
  if (typeof document !== 'undefined') {
    document.cookie = 'auth_token=; path=/; max-age=0; SameSite=Lax';
  }
}

/**
 * Synchronizes user authentication metadata into Cloud Firestore via the Control Plane backend.
 * Performing this via the Control Plane prevents browser ad-blockers from blocking client-side Firestore WebChannels (ERR_BLOCKED_BY_CLIENT).
 */
export async function syncUserProfile(
  user: FirebaseUser,
  idToken?: string,
  extra?: { role?: 'user' | 'admin'; name?: string },
): Promise<void> {
  const token = idToken || (await user.getIdToken().catch(() => null));
  if (token) {
    setAccessToken(token);
    setClientAuthCookie();
  }
  try {
    await apiClient.post(
      '/api/v1/auth/sync',
      {
        idToken: token,
        name: extra?.name || user.displayName || user.email?.split('@')[0] || 'User',
        role: extra?.role || 'user',
      },
    );
  } catch {
    // Best-effort server sync; subsequent Bearer token verification also syncs user to Firestore
  }
}

/**
 * Sign in with Google Popup
 */
export async function loginWithGoogle(): Promise<{ user: FirebaseUser; idToken: string }> {
  if (!auth || !googleProvider) {
    throw new Error(
      'Firebase Authentication is not configured. Please supply NEXT_PUBLIC_FIREBASE_* environment variables.',
    );
  }

  const result: UserCredential = await signInWithPopup(auth, googleProvider);
  const idToken = await result.user.getIdToken();
  setAccessToken(idToken);
  setClientAuthCookie();
  await syncUserProfile(result.user, idToken);
  return { user: result.user, idToken };
}

/**
 * Register with Email and Password
 */
export async function registerWithEmail(
  email: string,
  password: string,
  name?: string,
): Promise<{ user: FirebaseUser; idToken: string }> {
  if (!auth) {
    throw new Error(
      'Firebase Authentication is not configured. Please supply NEXT_PUBLIC_FIREBASE_* environment variables.',
    );
  }

  const result: UserCredential = await createUserWithEmailAndPassword(auth, email, password);
  const idToken = await result.user.getIdToken();
  setAccessToken(idToken);
  setClientAuthCookie();
  await syncUserProfile(result.user, idToken, { name });
  return { user: result.user, idToken };
}

/**
 * Login with Email and Password
 */
export async function loginWithEmail(
  email: string,
  password: string,
): Promise<{ user: FirebaseUser; idToken: string }> {
  if (!auth) {
    throw new Error(
      'Firebase Authentication is not configured. Please supply NEXT_PUBLIC_FIREBASE_* environment variables.',
    );
  }

  const result: UserCredential = await signInWithEmailAndPassword(auth, email, password);
  const idToken = await result.user.getIdToken();
  setAccessToken(idToken);
  setClientAuthCookie();
  await syncUserProfile(result.user, idToken);
  return { user: result.user, idToken };
}

/**
 * Log out from Firebase
 */
export async function logoutFirebase(): Promise<void> {
  clearClientAuthCookie();
  if (!auth) return;
  await signOut(auth);
}

/**
 * Get current ID token or refresh it
 */
export async function getCurrentIdToken(forceRefresh = false): Promise<string | null> {
  if (!auth || !auth.currentUser) return null;
  return auth.currentUser.getIdToken(forceRefresh);
}

/**
 * Subscribe to Firebase auth state changes
 */
export function onFirebaseAuthStateChanged(
  callback: (user: FirebaseUser | null) => void,
): () => void {
  if (!auth) {
    return () => {};
  }
  return onAuthStateChanged(auth, callback);
}

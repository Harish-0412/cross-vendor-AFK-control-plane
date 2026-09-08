// freebuff/control-plane/src/auth/firebase-admin.ts
// Firebase Admin SDK initialization and verification helpers

import * as fs from 'node:fs';
import { initializeApp, cert, getApps, getApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth, type DecodedIdToken } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';

let adminApp: App | null = null;
let adminAuth: Auth | null = null;
let adminDb: Firestore | null = null;
let adminMessaging: Messaging | null = null;

export function isFirebaseAdminConfigured(): boolean {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
    return true;
  }
  return Boolean(
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY,
  );
}

export function initFirebaseAdmin(): App | null {
  if (adminApp) return adminApp;
  if (getApps().length > 0) {
    adminApp = getApp();
    adminAuth = getAuth(adminApp);
    adminDb = getFirestore(adminApp);
    adminMessaging = getMessaging(adminApp);
    return adminApp;
  }

  try {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (credPath && fs.existsSync(credPath)) {
      const fileContent = fs.readFileSync(credPath, 'utf8');
      const serviceAccount = JSON.parse(fileContent);
      adminApp = initializeApp({
        credential: cert(serviceAccount),
        projectId: serviceAccount.project_id || process.env.FIREBASE_PROJECT_ID,
      });
    } else if (
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY
    ) {
      const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
      adminApp = initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey,
        }),
        projectId: process.env.FIREBASE_PROJECT_ID,
      });
    } else {
      return null;
    }

    if (adminApp) {
      adminAuth = getAuth(adminApp);
      adminDb = getFirestore(adminApp);
      adminMessaging = getMessaging(adminApp);
      // eslint-disable-next-line no-console
      console.info('[Firebase Admin] Successfully initialized for project:', adminApp.options.projectId);
    }
    return adminApp;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[Firebase Admin] Failed to initialize Firebase Admin SDK:', error);
    return null;
  }
}

export function getFirebaseAuth(): Auth | null {
  if (!adminAuth) {
    initFirebaseAdmin();
  }
  return adminAuth;
}

export function getFirebaseFirestore(): Firestore | null {
  if (!adminDb) {
    initFirebaseAdmin();
  }
  return adminDb;
}

export function getFirebaseMessaging(): Messaging | null {
  if (!adminMessaging) {
    initFirebaseAdmin();
  }
  return adminMessaging;
}

/**
 * Verify a Firebase client ID token.
 * Returns the decoded token containing uid, email, etc., or null if invalid or not configured.
 */
export async function verifyFirebaseIdToken(idToken: string): Promise<DecodedIdToken | null> {
  const auth = getFirebaseAuth();
  if (!auth) return null;

  try {
    const decoded = await auth.verifyIdToken(idToken);
    return decoded;
  } catch (err) {
    return null;
  }
}

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mocked before importing anything that transitively pulls in firebase-admin,
// so `ControlPlane`/`HttpRouter` see the mock rather than trying to
// initialize a real Firebase Admin SDK (no credentials exist in this test
// environment, and none should be required to prove this authorization
// logic is correct).
vi.mock('../src/auth/firebase-admin', () => ({
  verifyFirebaseIdToken: vi.fn(),
  isFirebaseAdminConfigured: () => false,
  initFirebaseAdmin: () => null,
  getFirebaseMessaging: () => null,
}));

import { verifyFirebaseIdToken } from '../src/auth/firebase-admin';
import { ControlPlane } from '../src/control-plane';

/**
 * §4.3 of the pre-deployment audit: `authUser.role` used to be read directly
 * from the Firebase ID token's custom claim, while a newly-created user was
 * always given `role: 'user'` in the database — a source-of-truth mismatch
 * where the token could claim a higher role than the database ever granted.
 * Role must always come from the database record.
 */
describe('Auth: role is sourced from the database, not the ID token claim', () => {
  let cp: ControlPlane;
  let baseUrl: string;

  beforeEach(async () => {
    cp = new ControlPlane({ port: 0 });
    const { url } = await cp.start();
    baseUrl = url;
  });

  afterEach(async () => {
    await cp.stop();
    vi.clearAllMocks();
  });

  it('ignores a role claim on the ID token for a newly-seen user and stores/reports "user"', async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({
      uid: 'firebase_uid_attacker',
      email: 'attacker@example.com',
      role: 'admin', // forged/attempted-privilege-escalation claim
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: 'Bearer fake-firebase-token' },
    });
    const body = (await res.json()) as { user: { role: string } };

    expect(res.status).toBe(200);
    expect(body.user.role).toBe('user');
  });

  it("does not let a later request's forged claim override an existing user's real database role", async () => {
    // First request creates the user (role defaults to 'user' regardless of
    // the token's claim, per the fix above).
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({
      uid: 'firebase_uid_2',
      email: 'person@example.com',
      role: 'user',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: 'Bearer token-1' },
    });

    // Second request: same user, but now the token (attacker-controlled in
    // the threat this fix closes) claims 'admin'.
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({
      uid: 'firebase_uid_2',
      email: 'person@example.com',
      role: 'admin',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: 'Bearer token-2' },
    });
    const body = (await res.json()) as { user: { role: string } };

    expect(body.user.role).toBe('user');
  });
});

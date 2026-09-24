import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock before importing the Control Plane: these tests prove the boundary
// after Firebase Admin has verified a token; they never need real credentials.
vi.mock('../src/auth/firebase-admin', () => ({
  verifyFirebaseIdToken: vi.fn(),
  isFirebaseAdminConfigured: () => false,
  initFirebaseAdmin: () => null,
  getFirebaseMessaging: () => null,
}));

import { verifyFirebaseIdToken } from '../src/auth/firebase-admin';
import { ControlPlane } from '../src/control-plane';

const firebaseToken = (uid: string, email: string, claims: Record<string, unknown> = {}) => ({
  uid,
  email,
  ...claims,
  // The production function can only return this after Firebase Admin has
  // checked signature, issuer and audience. The test double represents that
  // verified boundary, not an untrusted browser payload.
});

describe('Auth: Firebase custom role synchronization', () => {
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

  it('provisions a verified Firebase owner claim as a durable owner role that can open admin routes', async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue(
      firebaseToken('firebase_owner', 'owner@example.com', { role: 'owner' }) as never,
    );

    const me = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: 'Bearer verified-firebase-token' },
    });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { role: string } }).user.role).toBe('owner');

    const admin = await fetch(`${baseUrl}/api/v1/admin/stats`, {
      headers: { Authorization: 'Bearer verified-firebase-token' },
    });
    expect(admin.status).toBe(200);
    const stored = await cp.db.users.findById('firebase_owner');
    expect(stored?.role).toBe('owner');
    expect(stored?.metadata?._odysseusRoleAuthority).toBe('firebase-custom-claim');
  });

  it('supports the namespaced odysseusRole claim and never promotes unrecognised claims', async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue(
      firebaseToken('firebase_admin', 'admin@example.com', { odysseusRole: 'admin' }) as never,
    );
    let response = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: 'Bearer verified-admin-token' },
    });
    expect(((await response.json()) as { user: { role: string } }).user.role).toBe('admin');

    vi.mocked(verifyFirebaseIdToken).mockResolvedValue(
      firebaseToken('firebase_untrusted', 'untrusted@example.com', { role: 'super-admin' }) as never,
    );
    response = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: 'Bearer verified-unrecognised-token' },
    });
    expect(((await response.json()) as { user: { role: string } }).user.role).toBe('user');
  });

  it('demotes Firebase-managed roles when a refreshed verified token no longer carries the claim', async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue(
      firebaseToken('firebase_revoked', 'revoked@example.com', { role: 'owner' }) as never,
    );
    await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: 'Bearer owner-token' },
    });

    vi.mocked(verifyFirebaseIdToken).mockResolvedValue(
      firebaseToken('firebase_revoked', 'revoked@example.com') as never,
    );
    const me = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: 'Bearer refreshed-token-without-role' },
    });
    expect(((await me.json()) as { user: { role: string } }).user.role).toBe('user');

    const admin = await fetch(`${baseUrl}/api/v1/admin/stats`, {
      headers: { Authorization: 'Bearer refreshed-token-without-role' },
    });
    expect(admin.status).toBe(403);
  });

  it('does not let a Firebase claim override a role deliberately managed in Odysseus', async () => {
    await cp.db.users.create({
      id: 'platform_admin',
      email: 'platform@example.com',
      name: 'Platform admin',
      role: 'admin',
      metadata: { _odysseusRoleAuthority: 'control-plane' },
    });
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue(
      firebaseToken('platform_admin', 'platform@example.com', { role: 'user' }) as never,
    );

    const me = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: 'Bearer verified-firebase-token' },
    });
    expect(((await me.json()) as { user: { role: string } }).user.role).toBe('admin');
  });
});

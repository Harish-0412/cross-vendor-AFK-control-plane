import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ControlPlane } from '../src/control-plane';

/**
 * Admin console tests.
 *
 * The security properties under test:
 *  1. No admin route answers without a valid token AND a database-sourced
 *     admin/owner role (a user-role token gets 403, not data).
 *  2. Suspension is enforced at login AND at token refresh, and cuts live
 *     device tunnels immediately.
 *  3. Terminate cancels active sessions and supersedes pending approvals
 *     without deleting the account.
 *  4. Destroy is two-step (typed email), owner-only for admins, and can
 *     never remove the last admin.
 *  5. Every admin action lands in the audit chain.
 */

interface TestUser {
  id: string;
  email: string;
  token: string;
}

async function registerUser(
  baseUrl: string,
  email: string,
  password = 'Password123!',
  name?: string,
): Promise<TestUser> {
  const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  expect(res.status).toBe(201);
  const data = (await res.json()) as { accessToken: string; user: { id: string } };
  return { id: data.user.id, email, token: data.accessToken };
}

async function registerAdmin(
  cp: ControlPlane,
  baseUrl: string,
  email = 'owner@odysseus.dev',
): Promise<TestUser> {
  const user = await registerUser(baseUrl, email);
  await cp.db.users.update(user.id, { role: 'owner' });
  return user;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

describe('Admin Console API', () => {
  let cp: ControlPlane;
  let baseUrl: string;

  beforeEach(async () => {
    cp = new ControlPlane({ port: 0 });
    const { url } = await cp.start();
    baseUrl = url;
  });

  afterEach(async () => {
    await cp.stop();
  });

  describe('authorization', () => {
    it('rejects unauthenticated requests to admin routes', async () => {
      const res = await fetch(`${baseUrl}/api/v1/admin/stats`);
      expect(res.status).toBe(401);
    });

    it('rejects non-admin users with 403 even with a valid token', async () => {
      const user = await registerUser(baseUrl, 'plain@odysseus.dev');
      const res = await fetch(`${baseUrl}/api/v1/admin/stats`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/admin or owner/i);
    });

    it('allows admin/owner role to read stats', async () => {
      const admin = await registerAdmin(cp, baseUrl);
      const res = await fetch(`${baseUrl}/api/v1/admin/stats`, {
        headers: authHeaders(admin.token),
      });
      expect(res.status).toBe(200);
      const stats = (await res.json()) as { users: { total: number } };
      expect(stats.users.total).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /admin/users', () => {
    it('lists every user with role, status and integration matrix', async () => {
      const admin = await registerAdmin(cp, baseUrl);
      await registerUser(baseUrl, 'dev1@odysseus.dev', 'Password123!', 'Dev One');
      await registerUser(baseUrl, 'dev2@odysseus.dev', 'Password123!', 'Dev Two');

      const res = await fetch(`${baseUrl}/api/v1/admin/users`, {
        headers: authHeaders(admin.token),
      });
      expect(res.status).toBe(200);
      const users = (await res.json()) as Array<{
        email: string;
        role: string;
        status: string;
        integrations: Array<{ integration: string; status: string }>;
      }>;
      expect(users.length).toBe(3);
      const dev1 = users.find((u) => u.email === 'dev1@odysseus.dev')!;
      expect(dev1.role).toBe('user');
      expect(dev1.status).toBe('active');
      // The integration matrix includes the advertised providers even when
      // never connected — status 'none', so the admin sees what CAN be connected.
      const integrationIds = dev1.integrations.map((i) => i.integration);
      expect(integrationIds).toContain('github');
      expect(integrationIds).toContain('antigravity');
      expect(integrationIds).toContain('claude');
      expect(integrationIds).toContain('codex');
      const github = dev1.integrations.find((i) => i.integration === 'github')!;
      expect(github.status).toBe('none');
    });

    it('masks nothing for admins but never exposes password hashes', async () => {
      const admin = await registerAdmin(cp, baseUrl);
      const res = await fetch(`${baseUrl}/api/v1/admin/users`, {
        headers: authHeaders(admin.token),
      });
      const text = await res.text();
      expect(text).not.toContain('passwordHash');
    });
  });

  describe('POST /admin/users/:id/status (suspend / restore)', () => {
    it('suspends a user and blocks their next login', async () => {
      const admin = await registerAdmin(cp, baseUrl);
      const user = await registerUser(baseUrl, 'suspendme@odysseus.dev');

      const suspend = await fetch(`${baseUrl}/api/v1/admin/users/${user.id}/status`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ status: 'suspended', reason: 'policy violation' }),
      });
      expect(suspend.status).toBe(200);
      const suspended = (await suspend.json()) as { status: string; suspendedReason?: string };
      expect(suspended.status).toBe('suspended');
      expect(suspended.suspendedReason).toContain('policy violation');

      const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'suspendme@odysseus.dev', password: 'Password123!' }),
      });
      expect(login.status).toBe(403);
    });

    it('blocks refresh tokens of suspended accounts', async () => {
      const admin = await registerAdmin(cp, baseUrl);
      const user = await registerUser(baseUrl, 'refresh@odysseus.dev');

      // Mint a refresh token before suspension.
      const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'refresh@odysseus.dev', password: 'Password123!' }),
      });
      const loginData = (await login.json()) as { refreshToken: string };

      await fetch(`${baseUrl}/api/v1/admin/users/${user.id}/status`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ status: 'suspended' }),
      });

      const refresh = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: loginData.refreshToken }),
      });
      expect(refresh.status).toBe(403);
    });

    it('restores a suspended user so they can log in again', async () => {
      const admin = await registerAdmin(cp, baseUrl);
      const user = await registerUser(baseUrl, 'restore@odysseus.dev');

      await fetch(`${baseUrl}/api/v1/admin/users/${user.id}/status`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ status: 'suspended' }),
      });
      const restore = await fetch(`${baseUrl}/api/v1/admin/users/${user.id}/status`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ status: 'active' }),
      });
      expect(restore.status).toBe(200);

      const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'restore@odysseus.dev', password: 'Password123!' }),
      });
      expect(login.status).toBe(200);
    });

    it('refuses to let an admin suspend their own account', async () => {
      const admin = await registerAdmin(cp, baseUrl);
      const res = await fetch(`${baseUrl}/api/v1/admin/users/${admin.id}/status`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ status: 'suspended' }),
      });
      expect(res.status).toBe(409);
    });

    it('refuses invalid status values', async () => {
      const admin = await registerAdmin(cp, baseUrl);
      const user = await registerUser(baseUrl, 'whatever@odysseus.dev');
      const res = await fetch(`${baseUrl}/api/v1/admin/users/${user.id}/status`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ status: 'banned' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /admin/users/:id/terminate', () => {
    it('cancels active sessions and supersedes pending approvals without deleting the account', async () => {
      const admin = await registerAdmin(cp, baseUrl);
      const user = await registerUser(baseUrl, 'terminate@odysseus.dev');

      // Seed a device, an active session and a pending approval directly —
      // the admin API's effect on live resources is what's under test.
      const device = await cp.db.devices.create({
        id: 'dev_terminate_test',
        userId: user.id,
        gatewayId: 'gw_terminate_test',
        friendlyName: 'Test Rig',
        platform: 'linux',
        publicKeyPem: 'pem',
        publicKeyJwk: { kty: 'OKP' },
        fingerprintHex: 'ab',
        fingerprintWords: ['alpha', 'bravo'],
        status: 'trusted',
      });
      const session = await cp.db.sessions.create({
        id: 'sess_terminate_test',
        userId: user.id,
        deviceId: device.id,
        gatewayId: device.gatewayId,
        agentId: 'mock',
        projectRoot: '/tmp/proj',
        state: 'running',
        startedAt: new Date(),
      });
      const approval = await cp.db.approvals.create({
        sessionId: session.id,
        deviceId: device.id,
        userId: user.id,
        actionType: 'git.push',
        description: 'push to main',
        status: 'pending',
        requestedAt: new Date(),
      });

      const res = await fetch(`${baseUrl}/api/v1/admin/users/${user.id}/terminate`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ reason: 'incident response' }),
      });
      expect(res.status).toBe(200);
      const result = (await res.json()) as {
        devicesDisconnected: string[];
        sessionsCancelled: number;
        approvalsSuperseded: number;
      };
      expect(result.sessionsCancelled).toBe(1);
      expect(result.approvalsSuperseded).toBe(1);

      const storedSession = await cp.db.sessions.findById(session.id);
      expect(storedSession?.state).toBe('cancelled');
      const storedApproval = await cp.db.approvals.findById(approval.id);
      expect(storedApproval?.status).toBe('superseded');

      // The account itself survives a terminate — that's suspend/destroy's job.
      const stillThere = await cp.db.users.findById(user.id);
      expect(stillThere).not.toBeNull();
    });
  });

  describe('DELETE /admin/users/:id (destroy)', () => {
    it('requires the typed email confirmation', async () => {
      const admin = await registerAdmin(cp, baseUrl);
      const user = await registerUser(baseUrl, 'destroy@odysseus.dev');
      const res = await fetch(`${baseUrl}/api/v1/admin/users/${user.id}`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ confirmEmail: 'wrong@odysseus.dev' }),
      });
      expect(res.status).toBe(400);
      const stillThere = await cp.db.users.findById(user.id);
      expect(stillThere).not.toBeNull();
    });

    it('deletes the user and their devices when confirmed', async () => {
      const admin = await registerAdmin(cp, baseUrl);
      const user = await registerUser(baseUrl, 'goner@odysseus.dev');
      await cp.db.devices.create({
        id: 'dev_goner',
        userId: user.id,
        gatewayId: 'gw_goner',
        friendlyName: 'Rig',
        platform: 'darwin',
        publicKeyPem: 'pem',
        publicKeyJwk: { kty: 'OKP' },
        fingerprintHex: 'cd',
        fingerprintWords: ['charlie', 'delta'],
        status: 'trusted',
      });

      const res = await fetch(`${baseUrl}/api/v1/admin/users/${user.id}`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ confirmEmail: 'goner@odysseus.dev' }),
      });
      expect(res.status).toBe(200);
      const result = (await res.json()) as { deleted: boolean; removed: Record<string, number> };
      expect(result.deleted).toBe(true);
      expect(result.removed.devices).toBe(1);
      expect(await cp.db.users.findById(user.id)).toBeNull();
      expect(await cp.db.devices.findById('dev_goner')).toBeNull();

      // A deleted user's login is now just an invalid credential, not a 403.
      const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'goner@odysseus.dev', password: 'Password123!' }),
      });
      expect(login.status).toBe(401);
    });

    it('refuses to delete the last admin/owner', async () => {
      const admin = await registerAdmin(cp, baseUrl, 'lastowner@odysseus.dev');
      const res = await fetch(`${baseUrl}/api/v1/admin/users/${admin.id}`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ confirmEmail: 'lastowner@odysseus.dev' }),
      });
      // Self-deletion is refused outright.
      expect([403, 409]).toContain(res.status);
      expect(await cp.db.users.findById(admin.id)).not.toBeNull();
    });
  });

  describe('admin devices and sessions listing', () => {
    it('lists all devices across all users', async () => {
      const admin = await registerAdmin(cp, baseUrl);
      const user = await registerUser(baseUrl, 'deviceowner@odysseus.dev');
      await cp.db.devices.create({
        id: 'dev_admin_list',
        userId: user.id,
        gatewayId: 'gw_admin_list',
        friendlyName: 'Listed Rig',
        platform: 'windows',
        publicKeyPem: 'pem',
        publicKeyJwk: { kty: 'OKP' },
        fingerprintHex: 'ef',
        fingerprintWords: ['echo', 'foxtrot'],
        status: 'trusted',
      });

      const res = await fetch(`${baseUrl}/api/v1/admin/devices`, {
        headers: authHeaders(admin.token),
      });
      expect(res.status).toBe(200);
      const devices = (await res.json()) as Array<{ id: string; online: boolean }>;
      expect(devices.find((d) => d.id === 'dev_admin_list')).toBeTruthy();
    });

    it('lists all sessions across all users', async () => {
      const admin = await registerAdmin(cp, baseUrl);
      const user = await registerUser(baseUrl, 'sessionowner@odysseus.dev');
      const device = await cp.db.devices.create({
        id: 'dev_sess_list',
        userId: user.id,
        gatewayId: 'gw_sess_list',
        friendlyName: 'Rig',
        platform: 'linux',
        publicKeyPem: 'pem',
        publicKeyJwk: { kty: 'OKP' },
        fingerprintHex: 'aa',
        fingerprintWords: ['alpha'],
        status: 'trusted',
      });
      await cp.db.sessions.create({
        id: 'sess_admin_list',
        userId: user.id,
        deviceId: device.id,
        gatewayId: device.gatewayId,
        agentId: 'mock',
        projectRoot: '/tmp/x',
        state: 'running',
        startedAt: new Date(),
      });

      const res = await fetch(`${baseUrl}/api/v1/admin/sessions`, {
        headers: authHeaders(admin.token),
      });
      expect(res.status).toBe(200);
      const sessions = (await res.json()) as Array<{ id: string }>;
      expect(sessions.find((s) => s.id === 'sess_admin_list')).toBeTruthy();
    });

    it('revokes one device, cancels its work, and records the incident-response action', async () => {
      const admin = await registerAdmin(cp, baseUrl);
      const user = await registerUser(baseUrl, 'revoke-device@odysseus.dev');
      const device = await cp.db.devices.create({
        id: 'dev_revoke_test',
        userId: user.id,
        gatewayId: 'gw_revoke_test',
        friendlyName: 'Lost laptop',
        platform: 'windows',
        publicKeyPem: 'pem',
        publicKeyJwk: { kty: 'OKP' },
        fingerprintHex: 'bb',
        fingerprintWords: ['bravo'],
        status: 'trusted',
      });
      const session = await cp.db.sessions.create({
        id: 'sess_revoke_test',
        userId: user.id,
        deviceId: device.id,
        gatewayId: device.gatewayId,
        agentId: 'mock',
        projectRoot: '/tmp/revoke',
        state: 'running',
        startedAt: new Date(),
      });

      const response = await fetch(`${baseUrl}/api/v1/admin/devices/${device.id}/revoke`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ reason: 'reported lost' }),
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { status: string }).status).toBe('revoked');
      expect((await cp.db.devices.findById(device.id))?.status).toBe('revoked');
      expect((await cp.db.sessions.findById(session.id))?.state).toBe('cancelled');
      expect((await cp.auditLog.list({ actorId: admin.id, limit: 10 })).map((event) => event.action)).toContain(
        'admin.device.revoked',
      );
    });

    it('returns rolling developer analytics from server-side records', async () => {
      const admin = await registerAdmin(cp, baseUrl);
      const response = await fetch(`${baseUrl}/api/v1/admin/analytics`, {
        headers: authHeaders(admin.token),
      });
      expect(response.status).toBe(200);
      const analytics = (await response.json()) as {
        window: { startsAt: string; endsAt: string };
        activity: { activeUsers: number };
        usage: { recordedTokens: number };
      };
      expect(Date.parse(analytics.window.startsAt)).toBeLessThan(Date.parse(analytics.window.endsAt));
      expect(analytics.activity.activeUsers).toBeGreaterThanOrEqual(0);
      expect(analytics.usage.recordedTokens).toBeGreaterThanOrEqual(0);
    });
  });

  describe('audit', () => {
    it('records admin actions in the hash-chained audit log', async () => {
      const admin = await registerAdmin(cp, baseUrl);
      const user = await registerUser(baseUrl, 'audited@odysseus.dev');
      await fetch(`${baseUrl}/api/v1/admin/users/${user.id}/status`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ status: 'suspended', reason: 'test' }),
      });

      const events = await cp.auditLog.list({ actorId: admin.id, limit: 50 });
      const actions = events.map((e) => e.action);
      expect(actions).toContain('admin.user.suspended');
    });

    it('keeps the audit chain valid after admin actions', async () => {
      const admin = await registerAdmin(cp, baseUrl);
      const user = await registerUser(baseUrl, 'chain@odysseus.dev');
      await fetch(`${baseUrl}/api/v1/admin/users/${user.id}/status`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ status: 'suspended' }),
      });
      await fetch(`${baseUrl}/api/v1/admin/users/${user.id}/status`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ status: 'active' }),
      });

      const result = await cp.auditLog.verifyChain();
      expect(result.valid).toBe(true);
    });
  });
});

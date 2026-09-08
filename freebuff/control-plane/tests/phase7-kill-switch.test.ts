import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ControlPlane } from '../src/control-plane';

/**
 * Subphase 7.6 — Kill switch and lock (§2.5 of the Phase 7 plan).
 *
 * DoD:
 *  - kill-switch fan-out cancels every active session for a device in one
 *    call, verified against a fixture with three concurrent sessions;
 *  - the lock variant stops a HIGH-risk action mid-flight: a session already
 *    require_approval-pending gets its underlying approval superseded when
 *    the session locks (reusing Phase 5's superseded-on-revocation pattern),
 *    without terminating the process the way cancel does.
 */
describe('Subphase 7.6 kill switch and lock', () => {
  let cp: ControlPlane;
  let baseUrl: string;
  let accessToken: string;
  let userId: string;

  const DEVICE_ID = 'dev_ks';
  const GATEWAY_ID = 'gw_ks';

  beforeEach(async () => {
    cp = new ControlPlane({ port: 0 });
    ({ url: baseUrl } = await cp.start());
    const response = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'phase76@freebuff.dev', password: 'Password123!' }),
    });
    const result = await response.json() as { accessToken: string; user: { id: string } };
    accessToken = result.accessToken;
    userId = result.user.id;
    await cp.db.devices.create({
      id: DEVICE_ID,
      userId,
      gatewayId: GATEWAY_ID,
      friendlyName: 'Kill Switch Device',
      platform: 'linux',
      publicKeyPem: '',
      publicKeyJwk: {},
      fingerprintHex: 'KS76',
      fingerprintWords: ['kill', 'switch'],
      status: 'trusted',
    });
  });

  afterEach(async () => cp.stop());

  async function createSession(id: string, state: string): Promise<void> {
    await cp.db.sessions.create({
      id,
      userId,
      deviceId: DEVICE_ID,
      gatewayId: GATEWAY_ID,
      agentId: 'mock',
      projectRoot: '/workspace',
      state,
      config: { projectRoot: '/workspace', adapter: 'mock' },
      startedAt: new Date(),
    });
  }

  async function createPendingApproval(sessionId: string): Promise<string> {
    const record = await cp.approvalWorkflow.createApproval({
      sessionId,
      deviceId: DEVICE_ID,
      userId,
      actionType: 'process.exec',
      description: 'Run risky command',
      policyVersion: 'v1',
      matchedRules: ['rule-risk-high'],
    });
    return record.id;
  }

  function authHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` };
  }

  it('kill-switch cancels every active session in one call', async () => {
    // Fixture: three concurrent active sessions + one already-terminal session.
    await createSession('sess_ks_1', 'running');
    await createSession('sess_ks_2', 'waiting_for_approval');
    await createSession('sess_ks_3', 'paused');
    await createSession('sess_ks_done', 'completed');

    const response = await fetch(`${baseUrl}/api/v1/devices/${DEVICE_ID}/kill-switch`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      success: boolean;
      action: string;
      activeSessionCount: number;
      sessions: Array<{ sessionId: string; state: string }>;
    };
    expect(body.success).toBe(true);
    expect(body.action).toBe('kill-switch');
    expect(body.activeSessionCount).toBe(3);
    expect(body.sessions).toHaveLength(3);
    for (const s of body.sessions) {
      expect(s.state).toBe('cancelled');
    }

    // DB reflects cancellation for all three, terminal session untouched.
    const s1 = await cp.db.sessions.findById('sess_ks_1');
    const s2 = await cp.db.sessions.findById('sess_ks_2');
    const s3 = await cp.db.sessions.findById('sess_ks_3');
    const done = await cp.db.sessions.findById('sess_ks_done');
    expect(s1?.state).toBe('cancelled');
    expect(s2?.state).toBe('cancelled');
    expect(s3?.state).toBe('cancelled');
    expect(done?.state).toBe('completed');
  });

  it('kill-switch supersedes pending approvals and records an audit entry', async () => {
    await createSession('sess_ks_a', 'running');
    await createSession('sess_ks_b', 'waiting_for_approval');
    const apprA = await createPendingApproval('sess_ks_a');
    const apprB = await createPendingApproval('sess_ks_b');

    const response = await fetch(`${baseUrl}/api/v1/devices/${DEVICE_ID}/kill-switch`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ reason: 'Emergency stop' }),
    });
    const body = await response.json() as { approvalsSuperseded: number };
    expect(body.approvalsSuperseded).toBe(2);

    expect((await cp.db.approvals.findById(apprA))?.status).toBe('superseded');
    expect((await cp.db.approvals.findById(apprB))?.status).toBe('superseded');

    // Audit trail exists for the safety control itself.
    const events = await cp.auditLog.list({ limit: 50 });
    expect(events.some((e) => e.action === 'device.kill_switch' && e.deviceId === DEVICE_ID))
      .toBe(true);
  });

  it('lock flips active sessions to the locked profile without cancelling them', async () => {
    await createSession('sess_lock_1', 'running');
    await createSession('sess_lock_2', 'waiting_for_approval');

    const response = await fetch(`${baseUrl}/api/v1/devices/${DEVICE_ID}/lock`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      success: boolean;
      action: string;
      activeSessionCount: number;
    };
    expect(body.success).toBe(true);
    expect(body.action).toBe('lock');
    expect(body.activeSessionCount).toBe(2);

    // Sessions still exist (not cancelled), but now observation-only.
    const s1 = await cp.db.sessions.findById('sess_lock_1');
    const s2 = await cp.db.sessions.findById('sess_lock_2');
    expect(s1?.trustProfile).toBe('locked');
    expect(s2?.trustProfile).toBe('locked');
    expect(s1?.state).toBe('running');
    expect(s2?.state).toBe('waiting_for_approval');
  });

  it('lock supersedes a pending HIGH-risk approval (stops the action mid-flight)', async () => {
    await createSession('sess_lock_a', 'waiting_for_approval');
    const apprId = await createPendingApproval('sess_lock_a');

    const response = await fetch(`${baseUrl}/api/v1/devices/${DEVICE_ID}/lock`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    const body = await response.json() as { approvalsSuperseded: number };
    expect(body.approvalsSuperseded).toBe(1);
    expect((await cp.db.approvals.findById(apprId))?.status).toBe('superseded');

    // A superseded approval can no longer be decided (first valid decision wins).
    const decision = await cp.approvalWorkflow.submitDecision(apprId, userId, true);
    expect(decision.success).toBe(false);

    // Policy now denies even LOW-risk reads on the locked session.
    const decisionOutcome = await cp.policyService.evaluate('filesystem.read', 'low', {
      deviceId: DEVICE_ID,
      sessionId: 'sess_lock_a',
      userId,
    });
    expect(decisionOutcome.decision).toBe('deny');
  });

  it('requires device ownership for both operations', async () => {
    await createSession('sess_ks_own', 'running');

    // A second user cannot kill-switch or lock a device they do not own.
    const other = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'phase76b@freebuff.dev', password: 'Password123!' }),
    });
    const otherResult = await other.json() as { accessToken: string };
    const otherHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${otherResult.accessToken}`,
    };

    const ks = await fetch(`${baseUrl}/api/v1/devices/${DEVICE_ID}/kill-switch`, {
      method: 'POST',
      headers: otherHeaders,
      body: JSON.stringify({}),
    });
    expect(ks.status).toBe(404);

    const lock = await fetch(`${baseUrl}/api/v1/devices/${DEVICE_ID}/lock`, {
      method: 'POST',
      headers: otherHeaders,
      body: JSON.stringify({}),
    });
    expect(lock.status).toBe(404);

    // Unauthenticated calls are rejected.
    const anon = await fetch(`${baseUrl}/api/v1/devices/${DEVICE_ID}/kill-switch`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(anon.status).toBe(401);
  });
});
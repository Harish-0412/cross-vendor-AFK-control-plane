import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ControlPlane } from '../src/control-plane';

describe('Subphase 7.1 trust profile persistence', () => {
  let cp: ControlPlane;
  let baseUrl: string;
  let accessToken: string;
  let userId: string;

  beforeEach(async () => {
    cp = new ControlPlane({ port: 0 });
    ({ url: baseUrl } = await cp.start());
    const response = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'phase7@freebuff.dev', password: 'Password123!' }),
    });
    const result = await response.json() as {
      accessToken: string;
      user: { id: string };
    };
    accessToken = result.accessToken;
    userId = result.user.id;
    await cp.db.devices.create({
      id: 'dev_phase7',
      userId,
      gatewayId: 'gw_phase7',
      friendlyName: 'Phase 7 Device',
      platform: 'linux',
      publicKeyPem: '',
      publicKeyJwk: {},
      fingerprintHex: 'PHASE7',
      fingerprintWords: ['phase', 'seven'],
      status: 'trusted',
    });
  });

  afterEach(async () => cp.stop());

  it('sets a device default and copies it into newly created sessions', async () => {
    const patchResponse = await fetch(`${baseUrl}/api/v1/devices/dev_phase7`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ defaultTrustProfile: 'trusted-afk' }),
    });
    expect(patchResponse.status).toBe(200);
    expect((await patchResponse.json() as { defaultTrustProfile: string }).defaultTrustProfile)
      .toBe('trusted-afk');

    const createResponse = await fetch(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ deviceId: 'dev_phase7', projectRoot: '/workspace', agentId: 'mock' }),
    });
    const session = await createResponse.json() as { trustProfile: string };
    expect(session.trustProfile).toBe('trusted-afk');
  });

  it('changes an active session profile and policy reads the persisted value', async () => {
    await cp.db.sessions.create({
      id: 'sess_phase7',
      userId,
      deviceId: 'dev_phase7',
      gatewayId: 'gw_phase7',
      agentId: 'mock',
      projectRoot: '/workspace',
      state: 'running',
      config: { projectRoot: '/workspace', adapter: 'mock' },
      startedAt: new Date(),
    });

    const response = await fetch(`${baseUrl}/api/v1/sessions/sess_phase7/trust-profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ trustProfile: 'locked' }),
    });
    expect(response.status).toBe(200);

    const decision = await cp.policyService.evaluate('filesystem.read', 'low', {
      deviceId: 'dev_phase7',
      sessionId: 'sess_phase7',
      userId,
    });
    expect(decision.decision).toBe('deny');
    expect(decision.decision === 'deny' && decision.reason).toContain('locked');
  });

  it('rejects invalid profiles and profile changes on terminal sessions', async () => {
    const invalid = await fetch(`${baseUrl}/api/v1/devices/dev_phase7`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ defaultTrustProfile: 'unsafe' }),
    });
    expect(invalid.status).toBe(400);

    await cp.db.sessions.create({
      id: 'sess_done',
      userId,
      deviceId: 'dev_phase7',
      gatewayId: 'gw_phase7',
      agentId: 'mock',
      projectRoot: '/workspace',
      state: 'completed',
      config: { projectRoot: '/workspace', adapter: 'mock' },
      startedAt: new Date(),
    });
    const terminal = await fetch(`${baseUrl}/api/v1/sessions/sess_done/trust-profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ trustProfile: 'trusted-afk' }),
    });
    expect(terminal.status).toBe(409);
  });
});

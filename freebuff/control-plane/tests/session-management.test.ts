import { WebSocket } from 'ws';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ControlPlane } from '../src/control-plane';

describe('Subphase 3.5 — Task & Session Management APIs', () => {
  let cp: ControlPlane;
  let baseUrl: string;
  let tunnelUrl: string;
  let accessToken: string;

  beforeEach(async () => {
    cp = new ControlPlane({ port: 0 });
    const { url } = await cp.start();
    baseUrl = url;
    tunnelUrl = cp.getWsTunnelUrl();

    const regRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'session-test@freebuff.dev',
        password: 'Password123!',
        name: 'Session Tester',
      }),
    });
    const data = (await regRes.json()) as { accessToken: string };
    accessToken = data.accessToken;

    // Create and pair a device
    const deviceId = 'dev_session_test';
    await cp.db.pairings.create({
      code: 'SESS1-TEST',
      deviceId,
      gatewayId: 'gw_session_test',
      fingerprintHex: 'SESS1',
      fingerprintWords: ['session', 'test'],
      status: 'confirmed',
      expiresAt: new Date(Date.now() + 300_000),
    });
    await cp.db.devices.create({
      id: deviceId,
      gatewayId: 'gw_session_test',
      userId: (await cp.db.users.findByEmail('session-test@freebuff.dev'))!.id,
      friendlyName: 'Session Test Device',
      platform: 'linux',
      publicKeyPem: '',
      publicKeyJwk: {},
      fingerprintHex: 'SESS1',
      fingerprintWords: ['session', 'test'],
      status: 'trusted',
    });
  });

  afterEach(async () => {
    await cp.stop();
  });

  // Helper: connect gateway and return ws
  async function connectGateway(deviceId: string) {
    const ws = new WebSocket(tunnelUrl);
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    ws.send(JSON.stringify({
      id: 'auth',
      type: 'auth',
      sequence: 1,
      payload: { deviceId, gatewayId: 'gw_session_test' },
    }));
    await new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        if (JSON.parse(data.toString('utf8')).type === 'auth_success') resolve();
      });
    });
    return ws;
  }

  it('should create a session on a connected device and mark it running', async () => {
    const deviceId = 'dev_session_test';
    const gw = await connectGateway(deviceId);

    // Track commands from control plane
    let startCmd: Record<string, unknown> | null = null;
    gw.on('message', (data) => {
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.type === 'command' && (msg.payload as Record<string, unknown>).commandType === 'session.start') {
        startCmd = msg;
        gw.send(JSON.stringify({
          id: 'ack_' + msg.id,
          type: 'ack',
          sequence: 10,
          correlationId: msg.id,
          payload: { received: true },
        }));
      }
    });

    const res = await fetch(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        deviceId,
        agentId: 'mock',
        projectRoot: '/workspace',
        prompt: 'Build a CLI tool',
      }),
    });

    expect(res.status).toBe(201);
    const session = (await res.json()) as Record<string, unknown>;
    expect(session.id).toBeDefined();
    expect(session.state).toBe('running');
    expect(session.deviceId).toBe(deviceId);
    expect(session.agentId).toBe('mock');
    expect(session.projectRoot).toBe('/workspace');

    // Verify command was sent
    expect(startCmd).not.toBeNull();
    expect((startCmd!.payload as Record<string, unknown>).commandType).toBe('session.start');
    expect(((startCmd!.payload as Record<string, unknown>).payload as Record<string, unknown>).sessionId).toBe(session.id);

    gw.close();
  });

  it('should list sessions with filtering', async () => {
    const deviceId = 'dev_session_test';

    // Create two sessions
    await fetch(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ deviceId, agentId: 'mock', projectRoot: '/ws1' }),
    });
    await fetch(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ deviceId, agentId: 'claude', projectRoot: '/ws2' }),
    });

    // List all
    const allRes = await fetch(`${baseUrl}/api/v1/sessions`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(allRes.status).toBe(200);
    const all = (await allRes.json()) as Record<string, unknown>[];
    expect(all.length).toBe(2);

    // Filter by agentId
    const filteredRes = await fetch(
      `${baseUrl}/api/v1/sessions?agentId=claude`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const filtered = (await filteredRes.json()) as Record<string, unknown>[];
    expect(filtered.length).toBe(1);
    expect(filtered[0].agentId).toBe('claude');
  });

  it('should get session detail', async () => {
    const deviceId = 'dev_session_test';
    const createRes = await fetch(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ deviceId, agentId: 'mock', projectRoot: '/ws' }),
    });
    const { id: sessionId } = (await createRes.json()) as { id: string };

    const detailRes = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as Record<string, unknown>;
    expect(detail.id).toBe(sessionId);
    expect(detail.state).toBeDefined();
    expect(detail.config).toBeDefined();
  });

  it('should send a prompt to an active session', async () => {
    const deviceId = 'dev_session_test';
    const gw = await connectGateway(deviceId);

    let promptCmd: Record<string, unknown> | null = null;
    gw.on('message', (data) => {
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.type === 'command' && (msg.payload as Record<string, unknown>).commandType === 'session.message') {
        promptCmd = msg;
        gw.send(JSON.stringify({
          id: 'ack_' + msg.id,
          type: 'ack',
          sequence: 20,
          correlationId: msg.id,
          payload: { received: true },
        }));
      }
    });

    const createRes = await fetch(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ deviceId, agentId: 'mock', projectRoot: '/ws' }),
    });
    const { id: sessionId } = (await createRes.json()) as { id: string };

    const promptRes = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ message: 'What files did you create?' }),
    });

    expect(promptRes.status).toBe(200);
    const promptData = (await promptRes.json()) as Record<string, unknown>;
    expect(promptData.delivered).toBe(true);
    expect(promptData.acknowledged).toBe(true);

    expect(promptCmd).not.toBeNull();
    expect((promptCmd!.payload as Record<string, unknown>).commandType).toBe('session.message');
    expect(((promptCmd!.payload as Record<string, unknown>).payload as Record<string, unknown>).message).toBe('What files did you create?');

    gw.close();
  });

  it('should pause and resume a session', async () => {
    const deviceId = 'dev_session_test';
    const gw = await connectGateway(deviceId);

    let pauseCmd: Record<string, unknown> | null = null;
    let resumeCmd: Record<string, unknown> | null = null;
    gw.on('message', (data) => {
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.type === 'command') {
        const cmdType = (msg.payload as Record<string, unknown>).commandType as string;
        if (cmdType === 'session.pause') {
          pauseCmd = msg;
          gw.send(JSON.stringify({
            id: 'ack_' + msg.id,
            type: 'ack',
            sequence: 30,
            correlationId: msg.id,
            payload: { received: true },
          }));
        } else if (cmdType === 'session.resume') {
          resumeCmd = msg;
          gw.send(JSON.stringify({
            id: 'ack_' + msg.id,
            type: 'ack',
            sequence: 40,
            correlationId: msg.id,
            payload: { received: true },
          }));
        }
      }
    });

    const createRes = await fetch(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ deviceId, agentId: 'mock', projectRoot: '/ws' }),
    });
    const { id: sessionId } = (await createRes.json()) as { id: string };

    // Pause
    const pauseRes = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/pause`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(pauseRes.status).toBe(200);
    expect((await pauseRes.json()).state).toBe('paused');
    expect(pauseCmd).not.toBeNull();

    // Resume
    const resumeRes = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/resume`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(resumeRes.status).toBe(200);
    expect((await resumeRes.json()).state).toBe('running');
    expect(resumeCmd).not.toBeNull();

    gw.close();
  });

  it('should cancel a session', async () => {
    const deviceId = 'dev_session_test';
    const gw = await connectGateway(deviceId);

    let stopCmd: Record<string, unknown> | null = null;
    gw.on('message', (data) => {
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.type === 'command' && (msg.payload as Record<string, unknown>).commandType === 'session.stop') {
        stopCmd = msg;
        gw.send(JSON.stringify({
          id: 'ack_' + msg.id,
          type: 'ack',
          sequence: 50,
          correlationId: msg.id,
          payload: { received: true },
        }));
      }
    });

    const createRes = await fetch(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ deviceId, agentId: 'mock', projectRoot: '/ws' }),
    });
    const { id: sessionId } = (await createRes.json()) as { id: string };

    const cancelRes = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ reason: 'User cancelled' }),
    });
    expect(cancelRes.status).toBe(200);
    const cancelData = (await cancelRes.json()) as Record<string, unknown>;
    expect(cancelData.state).toBe('cancelled');
    expect(cancelData.acknowledged).toBe(true);

    expect(stopCmd).not.toBeNull();
    expect((stopCmd!.payload as Record<string, unknown>).commandType).toBe('session.stop');
    expect(((stopCmd!.payload as Record<string, unknown>).payload as Record<string, unknown>).reason).toBe('User cancelled');

    gw.close();
  });

  it('should retrieve session events via replay API', async () => {
    // We need a session with events — let's use a connected gateway
    const deviceId = 'dev_session_test';
    const gw = await connectGateway(deviceId);

    // Create session
    const createRes = await fetch(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ deviceId, agentId: 'mock', projectRoot: '/ws' }),
    });
    const { id: sessionId } = (await createRes.json()) as { id: string };

    // Send a prompt to generate events
    await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ message: 'test' }),
    });

    // Events endpoint
    const eventsRes = await fetch(
      `${baseUrl}/api/v1/sessions/${sessionId}/events`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    expect(eventsRes.status).toBe(200);
    const events = (await eventsRes.json()) as Record<string, unknown>[];
    // May be empty since no gateway events were emitted, but endpoint works
    expect(Array.isArray(events)).toBe(true);

    gw.close();
  });
});

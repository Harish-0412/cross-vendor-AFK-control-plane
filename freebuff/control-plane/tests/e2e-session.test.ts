import { WebSocket } from 'ws';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ControlPlane } from '../src/control-plane';

describe('End-to-End Session Lifecycle & Real-time Multiplexing', () => {
  let cp: ControlPlane;
  let baseUrl: string;
  let tunnelUrl: string;
  let clientUrl: string;

  beforeEach(async () => {
    cp = new ControlPlane({ port: 0 });
    const { url } = await cp.start();
    baseUrl = url;
    tunnelUrl = cp.getWsTunnelUrl();
    clientUrl = cp.getWsClientUrl();
  });

  afterEach(async () => {
    await cp.stop();
  });

  it('should stream events from Gateway through Control Plane to Web Client in real-time', async () => {
    // 1. User registers & logs in
    const regRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'e2e@freebuff.dev',
        password: 'Password123!',
        name: 'E2E Tester',
      }),
    });
    const { accessToken: token, user } = (await regRes.json()) as any;

    // 2. Gateway initiates pairing & User confirms device
    const deviceId = 'dev_e2e_workstation_1';
    const gatewayId = 'gw_e2e_1';
    await fetch(`${baseUrl}/api/v1/internal/pairing/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'E2E1-PAIR',
        deviceId,
        gatewayId,
        fingerprintHex: 'ABCD1234',
        fingerprintWords: ['test', 'word'],
      }),
    });

    await fetch(`${baseUrl}/api/v1/devices/pair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ code: 'E2E1-PAIR' }),
    });

    await fetch(`${baseUrl}/api/v1/devices/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ code: 'E2E1-PAIR', confirmed: true, friendlyName: 'Workstation' }),
    });

    // 3. Gateway connects to Tunnel
    const gatewayWs = new WebSocket(tunnelUrl);
    await new Promise((resolve) => gatewayWs.on('open', resolve));

    // Gateway authenticates
    gatewayWs.send(
      JSON.stringify({
        id: 'msg_auth',
        type: 'auth',
        sequence: 1,
        timestamp: new Date().toISOString(),
        payload: { deviceId, gatewayId },
      }),
    );

    await new Promise<void>((resolve) => {
      gatewayWs.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.type === 'auth_success') resolve();
      });
    });

    expect(cp.registry.isDeviceOnline(deviceId)).toBe(true);

    // 4. Web Client connects to /ws/client with token
    const clientWs = new WebSocket(`${clientUrl}?token=${token}`);
    await new Promise((resolve) => clientWs.on('open', resolve));

    // Setup listener on Gateway for commands from Control Plane
    let receivedCommand: any = null;
    gatewayWs.on('message', (data) => {
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.type === 'command') {
        receivedCommand = msg;
        // Automatically ack command
        gatewayWs.send(
          JSON.stringify({
            id: 'ack_' + msg.id,
            type: 'ack',
            sequence: 10,
            correlationId: msg.id,
            timestamp: new Date().toISOString(),
            payload: { success: true },
          }),
        );
      }
    });

    // 5. Web Client starts a session via REST API
    const sessionRes = await fetch(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        deviceId,
        agentId: 'mock',
        projectRoot: 'C:/test/workspace',
        prompt: 'Build a login component',
      }),
    });

    expect(sessionRes.status).toBe(201);
    const session = (await sessionRes.json()) as any;
    expect(session.id).toBeDefined();

    // Verify Gateway received session.start command
    expect(receivedCommand).not.toBeNull();
    expect(receivedCommand.payload.commandType).toBe('session.start');
    expect(receivedCommand.payload.payload.sessionId).toBe(session.id);

    // 6. Web Client subscribes to session streaming events
    clientWs.send(
      JSON.stringify({
        action: 'subscribe_session',
        sessionId: session.id,
      }),
    );

    // Setup client listener for streamed events
    const receivedClientEvents: any[] = [];
    clientWs.on('message', (data) => {
      const parsed = JSON.parse(data.toString('utf8'));
      if (parsed.type === 'event') {
        receivedClientEvents.push(parsed);
      }
    });

    // 7. Gateway emits agent streaming output
    gatewayWs.send(
      JSON.stringify({
        id: 'msg_evt_1',
        type: 'event',
        sequence: 101,
        timestamp: new Date().toISOString(),
        payload: {
          eventId: 'evt_out_1',
          eventType: 'session.output',
          sessionId: session.id,
          sequence: 1,
          occurredAt: new Date().toISOString(),
          payload: { stream: 'stdout', content: 'Creating src/login.tsx...' },
        },
      }),
    );

    // Wait for client to receive event
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (receivedClientEvents.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    expect(receivedClientEvents.length).toBe(1);
    expect(receivedClientEvents[0].eventType).toBe('session.output');
    expect(receivedClientEvents[0].envelope.payload.content).toBe('Creating src/login.tsx...');

    // 8. Gateway emits approval request
    gatewayWs.send(
      JSON.stringify({
        id: 'msg_evt_2',
        type: 'event',
        sequence: 102,
        timestamp: new Date().toISOString(),
        payload: {
          eventId: 'evt_appr_1',
          eventType: 'session.approval_required',
          sessionId: session.id,
          sequence: 2,
          occurredAt: new Date().toISOString(),
          payload: {
            actionType: 'bash_command',
            description: 'Run `npm install lucide-react`',
          },
        },
      }),
    );

    // Fetch approvals via REST API
    await new Promise((r) => setTimeout(r, 100));
    const apprListRes = await fetch(`${baseUrl}/api/v1/sessions/${session.id}/approvals`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(apprListRes.status).toBe(200);
    const approvals = (await apprListRes.json()) as any[];
    expect(approvals.length).toBe(1);
    expect(approvals[0].status).toBe('pending');
    expect(approvals[0].description).toBe('Run `npm install lucide-react`');

    // 9. Web client submits approval decision
    let approvalDecisionCmd: any = null;
    gatewayWs.on('message', (data) => {
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.type === 'command' && msg.payload?.commandType === 'session.approve') {
        approvalDecisionCmd = msg;
      }
    });

    const decideRes = await fetch(
      `${baseUrl}/api/v1/sessions/${session.id}/approvals/${approvals[0].id}/decision`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ approved: true, reason: 'Approved by developer' }),
      },
    );
    expect(decideRes.status).toBe(200);

    // Wait for Gateway to receive approval decision command
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (approvalDecisionCmd) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    expect(approvalDecisionCmd.payload.commandType).toBe('session.approve');
    expect(approvalDecisionCmd.payload.payload.decision).toBe('granted');

    gatewayWs.close();
    clientWs.close();
  });
});

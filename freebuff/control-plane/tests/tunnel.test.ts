import { WebSocket } from 'ws';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ControlPlane } from '../src/control-plane';

describe('Subphase 3.4 — Tunnel Server & Realtime Multiplexer', () => {
  let cp: ControlPlane;
  let tunnelUrl: string;
  let clientUrl: string;

  beforeEach(async () => {
    cp = new ControlPlane({ port: 0 });
    await cp.start();
    tunnelUrl = cp.getWsTunnelUrl();
    clientUrl = cp.getWsClientUrl();
  });

  afterEach(async () => {
    await cp.stop();
  });

  // ──────────────────────────────────────────────────────────
  // Gateway Tunnel Authentication
  // ──────────────────────────────────────────────────────────
  describe('Gateway Tunnel Auth', () => {
    it('should authenticate a trusted gateway and return capabilities', async () => {
      await cp.db.devices.create({
        id: 'dev_auth_ok',
        gatewayId: 'gw_auth_ok',
        userId: 'usr_owner',
        friendlyName: 'Trusted Box',
        platform: 'linux',
        publicKeyPem: '',
        publicKeyJwk: {},
        fingerprintHex: 'HEX1234',
        fingerprintWords: ['apple', 'banana'],
        status: 'trusted',
      });

      const ws = new WebSocket(tunnelUrl);
      await new Promise<void>((resolve) => ws.on('open', () => resolve()));

      ws.send(JSON.stringify({
        id: 'a1',
        type: 'auth',
        sequence: 1,
        timestamp: new Date().toISOString(),
        payload: { deviceId: 'dev_auth_ok', gatewayId: 'gw_auth_ok' },
      }));

      const authMsg = await new Promise<Record<string, unknown>>((resolve) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString('utf8'));
          if (msg.type === 'auth_success') resolve(msg);
        });
      });

      expect(authMsg.type).toBe('auth_success');
      expect(cp.registry.isDeviceOnline('dev_auth_ok')).toBe(true);
      expect((authMsg.payload as Record<string, unknown>).capabilities).toContain('sessions');
      expect((authMsg.payload as Record<string, unknown>).capabilities).toContain('approvals');

      ws.close();
    });

    it('should reject a device that has never been paired', async () => {
      const ws = new WebSocket(tunnelUrl);
      await new Promise<void>((resolve) => ws.on('open', () => resolve()));

      ws.send(JSON.stringify({
        id: 'a2',
        type: 'auth',
        sequence: 1,
        payload: { deviceId: 'dev_never_paired', gatewayId: 'gw_evil' },
      }));

      const msg = await new Promise<Record<string, unknown>>((resolve) => {
        ws.on('message', (data) => {
          const m = JSON.parse(data.toString('utf8'));
          resolve(m);
        });
      });

      expect(msg.type).toBe('auth_failure');
      expect((msg.payload as Record<string, unknown>).code).toBe('DEVICE_NOT_TRUSTED');
      ws.close();
    });

    it('should reject a revoked device', async () => {
      await cp.db.devices.create({
        id: 'dev_revoked',
        gatewayId: 'gw_revoked',
        userId: 'usr_owner',
        friendlyName: 'Revoked Box',
        platform: 'windows',
        publicKeyPem: '',
        publicKeyJwk: {},
        fingerprintHex: 'HEX0000',
        fingerprintWords: ['alpha'],
        status: 'revoked',
      });

      const ws = new WebSocket(tunnelUrl);
      await new Promise<void>((resolve) => ws.on('open', () => resolve()));

      ws.send(JSON.stringify({
        id: 'a3',
        type: 'auth',
        sequence: 1,
        payload: { deviceId: 'dev_revoked', gatewayId: 'gw_revoked' },
      }));

      const msg = await new Promise<Record<string, unknown>>((resolve) => {
        ws.on('message', (data) => {
          const m = JSON.parse(data.toString('utf8'));
          resolve(m);
        });
      });

      expect(msg.type).toBe('auth_failure');
      expect((msg.payload as Record<string, unknown>).code).toBe('DEVICE_REVOKED');
      ws.close();
    });
  });

  // ──────────────────────────────────────────────────────────
  // Heartbeat Tracking
  // ──────────────────────────────────────────────────────────
  describe('Heartbeats', () => {
    it('should ack heartbeats and update lastSeenAt', async () => {
      await cp.db.devices.create({
        id: 'dev_hb',
        gatewayId: 'gw_hb',
        userId: 'usr_owner',
        friendlyName: 'HB Device',
        platform: 'darwin',
        publicKeyPem: '',
        publicKeyJwk: {},
        fingerprintHex: 'HBHB',
        fingerprintWords: ['kiwi'],
        status: 'trusted',
      });

      const ws = new WebSocket(tunnelUrl);
      await new Promise<void>((resolve) => ws.on('open', () => resolve()));

      ws.send(JSON.stringify({
        id: 'hb1',
        type: 'auth',
        sequence: 1,
        payload: { deviceId: 'dev_hb', gatewayId: 'gw_hb' },
      }));
      await new Promise<void>((resolve) => {
        ws.on('message', (data) => {
          if (JSON.parse(data.toString('utf8')).type === 'auth_success') resolve();
        });
      });

      const before = (await cp.db.devices.findById('dev_hb'))!.lastSeenAt!.getTime();
      await new Promise((r) => setTimeout(r, 20));

      ws.send(JSON.stringify({
        id: 'hb2',
        type: 'heartbeat',
        sequence: 2,
        payload: { cpu: 10, memoryMb: 2048 },
      }));

      const ack = await new Promise<Record<string, unknown>>((resolve) => {
        ws.on('message', (data) => {
          const m = JSON.parse(data.toString('utf8'));
          if (m.type === 'heartbeat') resolve(m);
        });
      });

      expect(ack.payload).toBeInstanceOf(Object);
      expect((ack.payload as Record<string, unknown>).ack).toBe(true);

      const after = (await cp.db.devices.findById('dev_hb'))!.lastSeenAt!.getTime();
      expect(after).toBeGreaterThan(before);

      ws.close();
    });
  });

  // ──────────────────────────────────────────────────────────
  // Realtime Event Multiplexing (Gateway → Client)
  // ──────────────────────────────────────────────────────────
  describe('Real-time Event Relay', () => {
    it('should forward a gateway event to a subscribed web client in real time', async () => {
      // User + device
      const reg = await fetch(`${cp.getUrl()}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'relay@test.dev', password: 'Password123!' }),
      });
      const { accessToken, user } = (await reg.json()) as { accessToken: string; user: { id: string } };

      const deviceId = 'dev_relay_1';
      await cp.db.pairings.create({
        code: 'RELAY1',
        deviceId,
        gatewayId: 'gw_relay',
        fingerprintHex: 'RELAY1',
        fingerprintWords: ['relay'],
        status: 'confirmed',
        expiresAt: new Date(Date.now() + 300_000),
      });
      await cp.db.devices.create({
        id: deviceId,
        gatewayId: 'gw_relay',
        userId: user.id,
        friendlyName: 'Relay Device',
        platform: 'linux',
        publicKeyPem: '',
        publicKeyJwk: {},
        fingerprintHex: 'RELAY1',
        fingerprintWords: ['relay'],
        status: 'trusted',
      });

      // Gateway connects
      const gw = new WebSocket(tunnelUrl);
      await new Promise<void>((resolve) => gw.on('open', () => resolve()));
      gw.send(JSON.stringify({
        id: 'gw_auth',
        type: 'auth',
        sequence: 1,
        payload: { deviceId, gatewayId: 'gw_relay' },
      }));
      await new Promise<void>((resolve) => {
        gw.on('message', (data) => {
          if (JSON.parse(data.toString('utf8')).type === 'auth_success') resolve();
        });
      });

      // Create a session so the event has a session context
      const sess = await fetch(`${cp.getUrl()}/api/v1/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ deviceId, agentId: 'mock', projectRoot: '/tmp' }),
      });
      const { id: sessionId } = (await sess.json()) as { id: string };

      // Web client subscribes to the session
      const client = new WebSocket(`${clientUrl}?token=${accessToken}`);
      await new Promise<void>((resolve) => client.on('open', () => resolve()));
      client.send(JSON.stringify({ action: 'subscribe_session', sessionId }));
      await new Promise<void>((resolve) => {
        client.on('message', (data) => {
          if (JSON.parse(data.toString('utf8')).type === 'subscribed') resolve();
        });
      });

      // Gateway emits an event
      gw.send(JSON.stringify({
        id: 'gw_evt',
        type: 'event',
        sequence: 10,
        payload: {
          eventId: 'evt_001',
          eventType: 'session.output',
          sessionId,
          sequence: 1,
          occurredAt: new Date().toISOString(),
          payload: { stream: 'stdout', content: 'hello from gateway' },
        },
      }));

      // Wait for client to receive the event
      const clientMsg = await new Promise<Record<string, unknown>>((resolve) => {
        const timeout = setTimeout(() => resolve(null), 5000);
        client.on('message', (data) => {
          const msg = JSON.parse(data.toString('utf8'));
          if (msg.type === 'event') {
            clearTimeout(timeout);
            resolve(msg);
          }
        });
      });

      expect(clientMsg).not.toBeNull();
      expect(clientMsg!.type).toBe('event');
      expect(clientMsg!.eventType).toBe('session.output');
      expect((clientMsg!.envelope as Record<string, unknown>).payload).toEqual({ stream: 'stdout', content: 'hello from gateway' });

      gw.close();
      client.close();
    });
  });

  // ──────────────────────────────────────────────────────────
  // Command Delivery & Acknowledgment
  // ──────────────────────────────────────────────────────────
  describe('Command round-trip', () => {
    it('should deliver a command to the gateway and receive an ack', async () => {
      await cp.db.devices.create({
        id: 'dev_cmd',
        gatewayId: 'gw_cmd',
        userId: 'usr_owner',
        friendlyName: 'Cmd Device',
        platform: 'windows',
        publicKeyPem: '',
        publicKeyJwk: {},
        fingerprintHex: 'CMD1234',
        fingerprintWords: ['cmd'],
        status: 'trusted',
      });

      const gw = new WebSocket(tunnelUrl);
      await new Promise<void>((resolve) => gw.on('open', () => resolve()));
      gw.send(JSON.stringify({
        id: 'c1',
        type: 'auth',
        sequence: 1,
        payload: { deviceId: 'dev_cmd', gatewayId: 'gw_cmd' },
      }));
      await new Promise<void>((resolve) => {
        gw.on('message', (data) => {
          if (JSON.parse(data.toString('utf8')).type === 'auth_success') resolve();
        });
      });

      // Track inbound commands
      let inboundCmd: Record<string, unknown> | null = null;
      gw.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.type === 'command') {
          inboundCmd = msg;
          gw.send(JSON.stringify({
            id: 'ack_' + msg.id,
            type: 'ack',
            sequence: 20,
            correlationId: msg.id,
            payload: { received: true, serverReceivedSequence: 20 },
          }));
        }
      });

      const result = await cp.tunnelServer.sendCommandToDevice('dev_cmd', 'session.pause', { sessionId: 'sess_123' });
      expect(result.delivered).toBe(true);
      expect(result.acknowledged).toBe(true);
      expect(inboundCmd).not.toBeNull();
      expect((inboundCmd!.payload as Record<string, unknown>).commandType).toBe('session.pause');

      gw.close();
    });

    it('should not hang when the gateway is offline', async () => {
      // Device exists but never connects
      await cp.db.devices.create({
        id: 'dev_offline_cmd',
        gatewayId: 'gw_offline',
        userId: 'usr_owner',
        friendlyName: 'Offline',
        platform: 'unknown',
        publicKeyPem: '',
        publicKeyJwk: {},
        fingerprintHex: 'OFF',
        fingerprintWords: ['offline'],
        status: 'trusted',
      });

      const result = await cp.tunnelServer.sendCommandToDevice('dev_offline_cmd', 'session.stop', {}, 500);
      expect(result.delivered).toBe(false);
      expect(result.acknowledged).toBe(false);
    });
  });
});

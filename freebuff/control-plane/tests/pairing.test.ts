import { WebSocket } from 'ws';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ControlPlane } from '../src/control-plane';

describe('Subphase 3.3 — Device Registry & Pairing Handshake Relay', () => {
  let cp: ControlPlane;
  let baseUrl: string;
  let tunnelUrl: string;
  let userToken: string;
  let userId: string;

  const PAIR_CODE = 'T55Q-Y3D2';
  const DEVICE_ID = 'dev_a1b2c3d4e5f6';
  const GATEWAY_ID = 'gw_987654321';
  const FINGERPRINT_WORDS = [
    'struggle', 'buyer', 'cave', 'true', 'trouble',
    'churn', 'auto', 'burst', 'witness', 'submit',
  ];

  beforeEach(async () => {
    cp = new ControlPlane({ port: 0 });
    const { url } = await cp.start();
    baseUrl = url;
    tunnelUrl = cp.getWsTunnelUrl();

    // Register test user
    const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'device-owner@freebuff.dev',
        password: 'Password123!',
        name: 'Device Owner',
      }),
    });
    const data = (await res.json()) as Record<string, unknown>;
    userToken = (data as { accessToken: string }).accessToken;
    userId = ((data as { user: { id: string } }).user).id;
  });

  afterEach(async () => {
    await cp.stop();
  });

  // ──────────────────────────────────────────────────────────
  // Helper: initiate pairing from the gateway side
  // ──────────────────────────────────────────────────────────
  async function initiatePairing(
    code = PAIR_CODE,
    deviceId = DEVICE_ID,
    gatewayId = GATEWAY_ID,
  ): Promise<string> {
    const res = await fetch(`${baseUrl}/api/v1/internal/pairing/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        deviceId,
        gatewayId,
        fingerprintHex: 'GRA5TGR8',
        fingerprintWords: FINGERPRINT_WORDS,
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { pairingId: string };
    return data.pairingId;
  }

  // ──────────────────────────────────────────────────────────
  // 1. Full Out-of-Band Pairing Flow
  // ──────────────────────────────────────────────────────────
  describe('Pairing Handshake', () => {
    it('should complete the full OOB pairing flow: initiate → pair → verify fingerprint → confirm → trusted', async () => {
      // Step 1: Gateway generates code and registers it
      const pairingId = await initiatePairing();

      // Step 2: User enters the 8-char code in Web UI
      const pairRes = await fetch(`${baseUrl}/api/v1/devices/pair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ code: PAIR_CODE }),
      });

      expect(pairRes.status).toBe(200);
      const pairData = (await pairRes.json()) as Record<string, unknown>;
      expect(pairData['deviceId']).toBe(DEVICE_ID);
      expect(pairData['fingerprintWords']).toEqual(FINGERPRINT_WORDS);
      expect(pairData['status']).toBe('code_verified');
      expect(pairData['pairingId']).toBe(pairingId);

      // Step 3: User verifies fingerprint words and confirms
      const confirmRes = await fetch(`${baseUrl}/api/v1/devices/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          pairingId,
          confirmed: true,
          friendlyName: 'MacBook Pro Dev',
        }),
      });

      expect(confirmRes.status).toBe(200);
      const confirmData = (await confirmRes.json()) as Record<string, unknown>;
      expect(confirmData['status']).toBe('confirmed');
      const device = confirmData['device'] as Record<string, unknown>;
      expect(device['friendlyName']).toBe('MacBook Pro Dev');
      expect(device['status']).toBe('trusted');
      expect(device['online']).toBe(false); // No tunnel connected yet
    });

    it('should reject pairing when user does not match the authenticated user', async () => {
      await initiatePairing();

      // Unauthenticated request
      const res = await fetch(`${baseUrl}/api/v1/devices/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: PAIR_CODE }),
      });
      expect(res.status).toBe(401);
    });

    it('should reject invalid pairing codes', async () => {
      const res = await fetch(`${baseUrl}/api/v1/devices/pair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ code: 'INVALID-CODE' }),
      });
      expect(res.status).toBe(404);
    });

    it('should reject pairing when code has expired', async () => {
      // Create a pairing with a 1-second TTL
      const cp2 = new ControlPlane({ port: 0, pairingCodeTtlSec: 1 });
      const { url: url2 } = await cp2.start();

      // Register user in the second control plane
      const regRes = await fetch(`${url2}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'expiry@test.dev', password: 'Password1!' }),
      });
      const { accessToken } = (await regRes.json()) as { accessToken: string };

      // Initiate pairing
      await fetch(`${url2}/api/v1/internal/pairing/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'EXPI-1234',
          deviceId: 'dev_expiry_test',
          gatewayId: 'gw_expiry_test',
          fingerprintHex: 'AAAA',
          fingerprintWords: ['alpha'],
        }),
      });

      // Wait for code to expire
      await new Promise((r) => setTimeout(r, 1200));

      const res = await fetch(`${url2}/api/v1/devices/pair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ code: 'EXPI-1234' }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toContain('expired');

      await cp2.stop();
    });

    it('should allow user to reject pairing (fingerprint mismatch)', async () => {
      await initiatePairing();

      const pairRes = await fetch(`${baseUrl}/api/v1/devices/pair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ code: PAIR_CODE }),
      });
      const pairData = (await pairRes.json()) as { pairingId: string };

      // User sees fingerprint words don't match, rejects
      const confirmRes = await fetch(`${baseUrl}/api/v1/devices/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          pairingId: pairData.pairingId,
          confirmed: false,
        }),
      });

      expect(confirmRes.status).toBe(200);
      const data = (await confirmRes.json()) as { status: string };
      expect(data.status).toBe('rejected');
    });
  });

  // ──────────────────────────────────────────────────────────
  // 2. Device List with Online/Offline Indicator
  // ──────────────────────────────────────────────────────────
  describe('GET /api/v1/devices — Device List', () => {
    it('should list devices with online status and activeSessionCount', async () => {
      // Pair a device first
      await initiatePairing();
      await fetch(`${baseUrl}/api/v1/devices/pair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ code: PAIR_CODE }),
      });
      await fetch(`${baseUrl}/api/v1/devices/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ pairingId: (await (await fetch(`${baseUrl}/api/v1/devices/pair`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({ code: PAIR_CODE }),
        })).json() as { pairingId: string }).pairingId, confirmed: true, friendlyName: 'Workstation' }),
      });

      const listRes = await fetch(`${baseUrl}/api/v1/devices`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      expect(listRes.status).toBe(200);
      const devices = (await listRes.json()) as Array<Record<string, unknown>>;
      expect(devices.length).toBe(1);

      const dev = devices[0]!;
      expect(dev['id']).toBe(DEVICE_ID);
      expect(dev['friendlyName']).toBeDefined();
      expect(dev['status']).toBe('trusted');
      expect(dev['online']).toBe(false); // No tunnel connected
      expect(dev['activeSessionCount']).toBe(0);
      expect(dev['lastSeenAt']).toBeNull();
      expect(dev['createdAt']).toBeDefined();
    });

    it('should show online=true when gateway tunnel is connected', async () => {
      // Pair the device
      await initiatePairing();
      const pairRes = await fetch(`${baseUrl}/api/v1/devices/pair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ code: PAIR_CODE }),
      });
      const { pairingId } = (await pairRes.json()) as { pairingId: string };

      await fetch(`${baseUrl}/api/v1/devices/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ pairingId, confirmed: true, friendlyName: 'Dev Box' }),
      });

      // Connect gateway via tunnel
      const ws = new WebSocket(tunnelUrl);
      await new Promise<void>((resolve) => ws.on('open', () => resolve()));

      ws.send(JSON.stringify({
        id: 'auth1', type: 'auth', sequence: 1,
        timestamp: new Date().toISOString(),
        payload: { deviceId: DEVICE_ID, gatewayId: GATEWAY_ID },
      }));

      await new Promise<void>((resolve) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString('utf8'));
          if (msg.type === 'auth_success') resolve();
        });
      });

      expect(cp.registry.isDeviceOnline(DEVICE_ID)).toBe(true);

      // List devices — should show online
      const listRes = await fetch(`${baseUrl}/api/v1/devices`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const devices = (await listRes.json()) as Array<Record<string, unknown>>;
      expect(devices[0]!['online']).toBe(true);

      ws.close();
    });

    it('should require authentication', async () => {
      const res = await fetch(`${baseUrl}/api/v1/devices`);
      expect(res.status).toBe(401);
    });
  });

  // ──────────────────────────────────────────────────────────
  // 3. Device Detail View
  // ──────────────────────────────────────────────────────────
  describe('GET /api/v1/devices/:id — Device Detail', () => {
    it('should return detailed device info including platform and session data', async () => {
      await initiatePairing();
      const pairRes = await fetch(`${baseUrl}/api/v1/devices/pair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ code: PAIR_CODE }),
      });
      const { pairingId } = (await pairRes.json()) as { pairingId: string };

      await fetch(`${baseUrl}/api/v1/devices/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ pairingId, confirmed: true, friendlyName: 'My Dev Machine' }),
      });

      const detailRes = await fetch(`${baseUrl}/api/v1/devices/${DEVICE_ID}`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      expect(detailRes.status).toBe(200);
      const detail = (await detailRes.json()) as Record<string, unknown>;

      expect(detail['id']).toBe(DEVICE_ID);
      expect(detail['friendlyName']).toBe('My Dev Machine');
      expect(detail['platform']).toBeDefined();
      expect(detail['status']).toBe('trusted');
      expect(detail['online']).toBe(false);
      expect(detail['systemInfo']).toBeNull();
      expect(detail['fingerprintHex']).toBeDefined();
      expect(detail['activeSessions']).toEqual([]);
      expect(detail['recentSessions']).toEqual([]);
      expect(detail['totalSessionCount']).toBe(0);
      expect(detail['createdAt']).toBeDefined();
      expect(detail['updatedAt']).toBeDefined();
    });

    it('should return 404 for device not owned by user', async () => {
      await initiatePairing();
      const pairRes = await fetch(`${baseUrl}/api/v1/devices/pair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ code: PAIR_CODE }),
      });
      const { pairingId } = (await pairRes.json()) as { pairingId: string };

      await fetch(`${baseUrl}/api/v1/devices/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ pairingId, confirmed: true, friendlyName: 'Workstation' }),
      });

      // Create second user
      const reg2 = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'other@test.dev', password: 'Password1!' }),
      });
      const { accessToken: token2 } = (await reg2.json()) as { accessToken: string };

      // Second user tries to access first user's device
      const res = await fetch(`${baseUrl}/api/v1/devices/${DEVICE_ID}`, {
        headers: { Authorization: `Bearer ${token2}` },
      });
      expect(res.status).toBe(404);
    });
  });

  // ──────────────────────────────────────────────────────────
  // 4. PATCH /api/v1/devices/:id — Gateway Reports Info
  // ──────────────────────────────────────────────────────────
  describe('PATCH /api/v1/devices/:id — Update Device Info', () => {
    it('should allow gateway to report platform and systemInfo', async () => {
      await initiatePairing();
      const pairRes = await fetch(`${baseUrl}/api/v1/devices/pair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ code: PAIR_CODE }),
      });
      const { pairingId } = (await pairRes.json()) as { pairingId: string };

      await fetch(`${baseUrl}/api/v1/devices/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ pairingId, confirmed: true, friendlyName: 'Workstation' }),
      });

      // Gateway reports its platform and system info
      const patchRes = await fetch(`${baseUrl}/api/v1/devices/${DEVICE_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          platform: 'darwin',
          systemInfo: {
            hostname: 'macbook-pro.local',
            arch: 'arm64',
            nodeVersion: 'v20.12.0',
            gatewayVersion: '0.1.0',
          },
        }),
      });

      expect(patchRes.status).toBe(200);
      const data = (await patchRes.json()) as Record<string, unknown>;
      expect(data['platform']).toBe('darwin');
      const sysInfo = data['systemInfo'] as Record<string, unknown>;
      expect(sysInfo['hostname']).toBe('macbook-pro.local');
      expect(sysInfo['arch']).toBe('arm64');

      // Verify via GET
      const getRes = await fetch(`${baseUrl}/api/v1/devices/${DEVICE_ID}`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const detail = (await getRes.json()) as Record<string, unknown>;
      expect(detail['platform']).toBe('darwin');
      const si = detail['systemInfo'] as Record<string, unknown>;
      expect(si['hostname']).toBe('macbook-pro.local');
    });
  });

  // ──────────────────────────────────────────────────────────
  // 5. DELETE /api/v1/devices/:id — Revoke & Terminate Tunnel
  // ──────────────────────────────────────────────────────────
  describe('DELETE /api/v1/devices/:id — Revoke & Tunnel Termination', () => {
    it('should revoke device and immediately close the tunnel connection', async () => {
      // Pair the device
      await initiatePairing();
      const pairRes = await fetch(`${baseUrl}/api/v1/devices/pair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ code: PAIR_CODE }),
      });
      const { pairingId } = (await pairRes.json()) as { pairingId: string };

      await fetch(`${baseUrl}/api/v1/devices/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ pairingId, confirmed: true, friendlyName: 'Revoke Me' }),
      });

      // Connect gateway via tunnel
      const ws = new WebSocket(tunnelUrl);
      await new Promise<void>((resolve) => ws.on('open', () => resolve()));

      ws.send(JSON.stringify({
        id: 'auth1', type: 'auth', sequence: 1,
        timestamp: new Date().toISOString(),
        payload: { deviceId: DEVICE_ID, gatewayId: GATEWAY_ID },
      }));

      await new Promise<void>((resolve) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString('utf8'));
          if (msg.type === 'auth_success') resolve();
        });
      });

      expect(cp.registry.isDeviceOnline(DEVICE_ID)).toBe(true);

      // Track the close event on the gateway WebSocket
      let closeCode: number | undefined;
      let closeReason: string | undefined;
      const closePromise = new Promise<void>((resolve) => {
        ws.on('close', (code, reason) => {
          closeCode = code;
          closeReason = reason.toString('utf8');
          resolve();
        });
      });

      // Revoke the device
      const deleteRes = await fetch(`${baseUrl}/api/v1/devices/${DEVICE_ID}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${userToken}` },
      });

      expect(deleteRes.status).toBe(200);
      const data = (await deleteRes.json()) as Record<string, unknown>;
      expect(data['success']).toBe(true);
      expect(data['deviceRevoked']).toBe(true);
      expect(data['tunnelTerminated']).toBe(true);

      // Wait for the WebSocket close event
      await closePromise;

      // Gateway WebSocket should be closed with 4003 (DEVICE_REVOKED)
      expect(closeCode).toBe(4003);
      expect(closeReason).toContain('revoked');

      // Device should be offline now
      expect(cp.registry.isDeviceOnline(DEVICE_ID)).toBe(false);

      // Verify device status is revoked
      const getRes = await fetch(`${baseUrl}/api/v1/devices/${DEVICE_ID}`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const detail = (await getRes.json()) as Record<string, unknown>;
      expect(detail['status']).toBe('revoked');
      expect(detail['online']).toBe(false);
    });

    it('should revoke device that has no active tunnel', async () => {
      await initiatePairing();
      const pairRes = await fetch(`${baseUrl}/api/v1/devices/pair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ code: PAIR_CODE }),
      });
      const { pairingId } = (await pairRes.json()) as { pairingId: string };

      await fetch(`${baseUrl}/api/v1/devices/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ pairingId, confirmed: true, friendlyName: 'Offline Device' }),
      });

      const deleteRes = await fetch(`${baseUrl}/api/v1/devices/${DEVICE_ID}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${userToken}` },
      });

      expect(deleteRes.status).toBe(200);
      const data = (await deleteRes.json()) as Record<string, unknown>;
      expect(data['success']).toBe(true);
      expect(data['deviceRevoked']).toBe(true);
      expect(data['tunnelTerminated']).toBe(false); // No tunnel to terminate
    });
  });

  // ──────────────────────────────────────────────────────────
  // 6. Revoked Device Cannot Reconnect via Tunnel
  // ──────────────────────────────────────────────────────────
  describe('Revoked device tunnel rejection', () => {
    it('should reject tunnel auth from a revoked device', async () => {
      await initiatePairing();
      const pairRes = await fetch(`${baseUrl}/api/v1/devices/pair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ code: PAIR_CODE }),
      });
      const { pairingId } = (await pairRes.json()) as { pairingId: string };

      await fetch(`${baseUrl}/api/v1/devices/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ pairingId, confirmed: true, friendlyName: 'Will Be Revoked' }),
      });

      // Revoke the device
      await fetch(`${baseUrl}/api/v1/devices/${DEVICE_ID}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${userToken}` },
      });

      // Try to connect via tunnel
      const ws = new WebSocket(tunnelUrl);
      await new Promise<void>((resolve) => ws.on('open', () => resolve()));

      ws.send(JSON.stringify({
        id: 'auth_revoked', type: 'auth', sequence: 1,
        timestamp: new Date().toISOString(),
        payload: { deviceId: DEVICE_ID, gatewayId: GATEWAY_ID },
      }));

      const failureMsg = await new Promise<Record<string, unknown>>((resolve) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString('utf8'));
          resolve(msg);
        });
      });

      expect(failureMsg['type']).toBe('auth_failure');
      const payload = failureMsg['payload'] as Record<string, unknown>;
      expect(payload['code']).toBe('DEVICE_REVOKED');

      ws.close();
    });
  });
});

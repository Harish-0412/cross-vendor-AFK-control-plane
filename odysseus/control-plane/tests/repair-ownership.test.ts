/**
 * Re-pairing a machine to a different account.
 *
 * The bug: a workstation keeps one device identity on disk. Pairing it first
 * under account A and later under account B confirmed the pairing, but the
 * device record kept `userId: A`. The gateway connected — its key still
 * matched — while B's website said "No devices paired".
 *
 * The fix moves the device, but only when the registration was signed with the
 * device key. Device ids are shown in the UI, so an unsigned registration that
 * names someone else's device must never be able to take it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { pairingSignatureBase } from '../src/auth/device-signature';
import { ControlPlane } from '../src/control-plane';

import { createTestIdentity, type TestDeviceIdentity } from './helpers/gateway-handshake';

const DEVICE_ID = 'dev_repair_owner_1';
const GATEWAY_ID = 'gw_repair_owner_1';

describe('Re-pairing an existing device to another account', () => {
  let cp: ControlPlane;
  let baseUrl: string;
  let identity: TestDeviceIdentity;

  beforeEach(async () => {
    cp = new ControlPlane({ port: 0 });
    baseUrl = (await cp.start()).url;
    identity = createTestIdentity(DEVICE_ID, GATEWAY_ID);
  });

  afterEach(async () => {
    await cp.stop();
  });

  async function register(email: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Password123!' }),
    });
    return ((await res.json()) as { accessToken: string }).accessToken;
  }

  async function initiate(
    code: string,
    options: { signWith?: TestDeviceIdentity; publicKeyFrom?: TestDeviceIdentity } = {},
  ): Promise<Response> {
    const keyOwner = options.publicKeyFrom ?? identity;
    const signed: Record<string, string> = {};
    if (options.signWith) {
      const timestamp = new Date().toISOString();
      signed['timestamp'] = timestamp;
      signed['signature'] = options.signWith.sign(
        pairingSignatureBase({ code, deviceId: DEVICE_ID, gatewayId: GATEWAY_ID, timestamp }),
      );
    }
    return fetch(`${baseUrl}/api/v1/internal/pairing/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        deviceId: DEVICE_ID,
        gatewayId: GATEWAY_ID,
        fingerprintHex: 'AB',
        fingerprintWords: ['one', 'two'],
        publicKeyJwk: keyOwner.publicKeyJwk,
        publicKeyPem: keyOwner.publicKeyPem,
        ...signed,
      }),
    });
  }

  async function pairAndConfirm(token: string, code: string): Promise<Response> {
    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const pair = await fetch(`${baseUrl}/api/v1/devices/pair`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ code }),
    });
    const { pairingId } = (await pair.json()) as { pairingId: string };
    return fetch(`${baseUrl}/api/v1/devices/confirm`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ pairingId, confirmed: true }),
    });
  }

  async function deviceIds(token: string): Promise<string[]> {
    const res = await fetch(`${baseUrl}/api/v1/devices`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return ((await res.json()) as Array<{ id: string }>).map((device) => device.id);
  }

  it('moves the device to the confirming account when the registration is key-signed', async () => {
    const first = await register('first@odysseus.dev');
    const second = await register('second@odysseus.dev');

    expect((await initiate('AAAA-1111', { signWith: identity })).status).toBe(201);
    expect((await pairAndConfirm(first, 'AAAA-1111')).status).toBe(200);
    expect(await deviceIds(first)).toEqual([DEVICE_ID]);

    expect((await initiate('BBBB-2222', { signWith: identity })).status).toBe(201);
    expect((await pairAndConfirm(second, 'BBBB-2222')).status).toBe(200);

    expect(await deviceIds(second)).toEqual([DEVICE_ID]);
    expect(await deviceIds(first)).toEqual([]);
  });

  it('refuses to move the device on an unsigned registration, and leaves it where it was', async () => {
    const owner = await register('owner@odysseus.dev');
    const other = await register('other@odysseus.dev');

    await initiate('CCCC-3333', { signWith: identity });
    await pairAndConfirm(owner, 'CCCC-3333');

    // Knows the device id and even the public key — both are visible — but
    // cannot sign, so it cannot prove it is the machine.
    expect((await initiate('DDDD-4444')).status).toBe(201);
    const confirm = await pairAndConfirm(other, 'DDDD-4444');
    expect(confirm.status).toBe(409);
    expect(((await confirm.json()) as { code: string }).code).toBe(
      'DEVICE_OWNED_BY_ANOTHER_ACCOUNT',
    );

    expect(await deviceIds(owner)).toEqual([DEVICE_ID]);
    expect(await deviceIds(other)).toEqual([]);
  });

  it('refuses a registration that names an existing device with a different key', async () => {
    const owner = await register('keyed@odysseus.dev');
    await initiate('EEEE-5555', { signWith: identity });
    await pairAndConfirm(owner, 'EEEE-5555');

    const attacker = createTestIdentity(DEVICE_ID, GATEWAY_ID);
    const res = await initiate('FFFF-6666', { signWith: attacker, publicKeyFrom: attacker });
    expect(res.status).toBe(409);
  });

  it('rejects a signature made with a key other than the one registered', async () => {
    const stranger = createTestIdentity(DEVICE_ID, GATEWAY_ID);
    const res = await initiate('GGGG-7777', { signWith: stranger });
    expect(res.status).toBe(400);
  });

  it('keeps the status endpoint to the caller’s own devices', async () => {
    expect((await fetch(`${baseUrl}/api/v1/status`)).status).toBe(401);

    const token = await register('status@odysseus.dev');
    const res = await fetch(`${baseUrl}/api/v1/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { connectedDevices: string[] }).connectedDevices).toEqual([]);
  });
});

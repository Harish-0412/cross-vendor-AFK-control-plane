import { WebSocket } from 'ws';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ControlPlane } from '../src/control-plane';

import {
  createTestIdentity,
  deviceRecordFor,
  performHandshake,
  type TestDeviceIdentity,
} from './helpers/gateway-handshake';

/**
 * The gateway tunnel used to authenticate on a claimed device id alone: send
 * `{deviceId, gatewayId}`, receive `auth_success`. Device ids are not secrets —
 * they appear in API responses, in the UI and in logs — so anyone who had seen
 * one could register as somebody's workstation, receive the session commands
 * meant for it, and publish events attributed to it.
 *
 * These tests are written from the attacker's side: each one is a thing that
 * used to work and must now fail.
 */
describe('gateway tunnel authentication', () => {
  let cp: ControlPlane;
  let tunnelUrl: string;
  let identity: TestDeviceIdentity;

  beforeEach(async () => {
    cp = new ControlPlane({ port: 0 });
    await cp.start();
    tunnelUrl = cp.getWsTunnelUrl();

    identity = createTestIdentity('dev_secure', 'gw_secure');
    await cp.db.devices.create(deviceRecordFor(identity) as never);
  });

  afterEach(async () => {
    await cp.stop();
  });

  async function openSocket(): Promise<WebSocket> {
    const ws = new WebSocket(tunnelUrl);
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    return ws;
  }

  /** Send one raw auth payload and resolve on whatever the server replies. */
  function sendRawAuth(ws: WebSocket, payload: Record<string, unknown>): Promise<{
    type: string;
    payload: Record<string, unknown>;
  }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no reply to auth')), 5_000);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf8')) as {
          type: string;
          payload: Record<string, unknown>;
        };
        if (msg.type.startsWith('auth')) {
          clearTimeout(timer);
          resolve(msg);
        }
      });
      ws.send(
        JSON.stringify({ id: 'raw', type: 'auth', sequence: 1, timestamp: new Date(), payload }),
      );
    });
  }

  function signedAuthPayload(
    signer: TestDeviceIdentity,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const nonce = `nonce_${Math.random().toString(36).slice(2)}`;
    const timestamp = new Date().toISOString();
    const base = JSON.stringify({
      deviceId: 'dev_secure',
      gatewayId: 'gw_secure',
      nonce,
      timestamp,
      certificateThumbprint: '',
    });
    return {
      deviceId: 'dev_secure',
      gatewayId: 'gw_secure',
      connectionId: 'default',
      nonce,
      timestamp,
      publicKeyJwk: signer.publicKeyJwk,
      signature: signer.sign(base),
      ...overrides,
    };
  }

  it('refuses a caller that knows the device id but holds no key', async () => {
    // This is the original hole, verbatim: the whole of the old auth payload.
    const ws = await openSocket();
    const reply = await sendRawAuth(ws, { deviceId: 'dev_secure', gatewayId: 'gw_secure' });

    expect(reply.type).toBe('auth_failure');
    expect(reply.payload['code']).toBe('SIGNATURE_INVALID');
    expect(cp.registry.isDeviceOnline('dev_secure')).toBe(false);
    ws.close();
  });

  it('refuses a caller signing with a key the device did not register', async () => {
    // An attacker can always generate their own key pair. What they cannot do
    // is make it the one stored for this device.
    const attacker = createTestIdentity('dev_secure', 'gw_secure');
    const ws = await openSocket();
    const reply = await sendRawAuth(ws, signedAuthPayload(attacker));

    expect(reply.type).toBe('auth_failure');
    expect(reply.payload['code']).toBe('SIGNATURE_INVALID');
    expect(cp.registry.isDeviceOnline('dev_secure')).toBe(false);
    ws.close();
  });

  it('ignores a public key presented in the payload in favour of the stored one', async () => {
    // Presenting a key and signing with its private half is the obvious
    // bypass: it is internally consistent and verifies against itself.
    const attacker = createTestIdentity('dev_secure', 'gw_secure');
    const ws = await openSocket();
    const reply = await sendRawAuth(
      ws,
      signedAuthPayload(attacker, { publicKeyJwk: attacker.publicKeyJwk }),
    );

    expect(reply.type).toBe('auth_failure');
    expect(reply.payload['code']).toBe('SIGNATURE_INVALID');
    ws.close();
  });

  it('accepts the real gateway and marks it online', async () => {
    const ws = await openSocket();
    const result = await performHandshake(ws, identity);

    expect(result.ok).toBe(true);
    expect(cp.registry.isDeviceOnline('dev_secure')).toBe(true);
    ws.close();
  });

  it('refuses a replayed auth payload, because the challenge cannot be answered', async () => {
    // A captured step-1 payload still has a valid signature — replaying it is
    // free. It earns a fresh challenge, and that is where the attacker stops.
    const captured = signedAuthPayload(identity);

    const victim = await openSocket();
    const challenge = await sendRawAuth(victim, captured);
    expect(challenge.type).toBe('auth_challenge');
    victim.close();

    const attacker = await openSocket();
    const replay = await sendRawAuth(attacker, captured);

    // The replayed nonce is refused outright; even if it were not, the
    // attacker would be left holding a challenge they cannot sign.
    expect(replay.type).toBe('auth_failure');
    expect(replay.payload['code']).toBe('REPLAYED_NONCE');
    expect(cp.registry.isDeviceOnline('dev_secure')).toBe(false);
    attacker.close();
  });

  it('refuses an auth payload whose timestamp is far from server time', async () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const base = JSON.stringify({
      deviceId: 'dev_secure',
      gatewayId: 'gw_secure',
      nonce: 'stale_nonce',
      timestamp: stale,
      certificateThumbprint: '',
    });

    const ws = await openSocket();
    const reply = await sendRawAuth(ws, {
      deviceId: 'dev_secure',
      gatewayId: 'gw_secure',
      nonce: 'stale_nonce',
      timestamp: stale,
      publicKeyJwk: identity.publicKeyJwk,
      signature: identity.sign(base),
    });

    expect(reply.type).toBe('auth_failure');
    expect(reply.payload['code']).toBe('CLOCK_SKEW');
    // Retryable: a wrong workstation clock is the common cause, not an attack.
    expect(reply.payload['retryable']).toBe(true);
    ws.close();
  });

  it('refuses a challenge response signed by the wrong key', async () => {
    const attacker = createTestIdentity('dev_secure', 'gw_secure');
    const ws = await openSocket();

    const challenge = await sendRawAuth(ws, signedAuthPayload(identity));
    expect(challenge.type).toBe('auth_challenge');

    const base = JSON.stringify({
      challenge: challenge.payload['challenge'],
      serverNonce: challenge.payload['serverNonce'],
      issuedAt: challenge.payload['issuedAt'],
    });

    const reply = await new Promise<{ type: string; payload: Record<string, unknown> }>(
      (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no reply')), 5_000);
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString('utf8')) as {
            type: string;
            payload: Record<string, unknown>;
          };
          if (msg.type === 'auth_success' || msg.type === 'auth_failure') {
            clearTimeout(timer);
            resolve(msg);
          }
        });
        ws.send(
          JSON.stringify({
            id: 'resp',
            type: 'auth',
            sequence: 2,
            payload: {
              challenge: challenge.payload['challenge'],
              serverNonce: challenge.payload['serverNonce'],
              deviceId: 'dev_secure',
              signature: attacker.sign(base),
            },
          }),
        );
      },
    );

    expect(reply.type).toBe('auth_failure');
    expect(reply.payload['code']).toBe('SIGNATURE_INVALID');
    expect(cp.registry.isDeviceOnline('dev_secure')).toBe(false);
    ws.close();
  });

  it('refuses a device whose stored record carries no public key', async () => {
    // Devices created before keys were bound at pairing time. They cannot be
    // verified, so they are refused with an error that says to re-pair rather
    // than being quietly trusted.
    await cp.db.devices.create({
      id: 'dev_legacy',
      gatewayId: 'gw_legacy',
      userId: 'usr_owner',
      friendlyName: 'Legacy',
      platform: 'unknown',
      publicKeyPem: '',
      publicKeyJwk: {},
      fingerprintHex: 'LEG',
      fingerprintWords: ['legacy'],
      status: 'trusted',
    } as never);

    const legacy = createTestIdentity('dev_legacy', 'gw_legacy');
    const ws = await openSocket();
    const nonce = 'legacy_nonce';
    const timestamp = new Date().toISOString();
    const base = JSON.stringify({
      deviceId: 'dev_legacy',
      gatewayId: 'gw_legacy',
      nonce,
      timestamp,
      certificateThumbprint: '',
    });

    const reply = await sendRawAuth(ws, {
      deviceId: 'dev_legacy',
      gatewayId: 'gw_legacy',
      nonce,
      timestamp,
      publicKeyJwk: legacy.publicKeyJwk,
      signature: legacy.sign(base),
    });

    expect(reply.type).toBe('auth_failure');
    expect(reply.payload['code']).toBe('DEVICE_KEY_MISSING');
    expect(reply.payload['retryable']).toBe(false);
    ws.close();
  });

  it('will not create a device from a pairing that registered no key', async () => {
    await cp.db.pairings.create({
      code: 'NOKEY-1234',
      deviceId: 'dev_nokey',
      gatewayId: 'gw_nokey',
      userId: 'usr_nokey',
      fingerprintHex: 'NOKEY',
      fingerprintWords: ['nokey'],
      status: 'confirmed',
      expiresAt: new Date(Date.now() + 300_000),
    } as never);

    const ws = await openSocket();
    const reply = await sendRawAuth(ws, {
      deviceId: 'dev_nokey',
      gatewayId: 'gw_nokey',
      nonce: 'n',
      timestamp: new Date().toISOString(),
      signature: 'whatever',
    });

    expect(reply.type).toBe('auth_failure');
    expect(reply.payload['code']).toBe('DEVICE_KEY_MISSING');
    // The device must not have been created: an unverifiable device row would
    // fail forever with a less useful error.
    expect(await cp.db.devices.findById('dev_nokey')).toBeNull();
    ws.close();
  });
});

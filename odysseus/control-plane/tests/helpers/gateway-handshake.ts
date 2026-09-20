/**
 * Test doubles that behave like a real gateway.
 *
 * The tunnel handshake is a challenge-response against a device's registered
 * public key, so a test gateway has to actually hold a private key and sign
 * with it. Faking `auth_success` here would test nothing: the whole point of
 * the handshake is that a caller who cannot sign is refused, and a fake that
 * skips signing would keep passing if the verification were deleted.
 *
 * Signing mirrors `gateway/identity/src/device-identity.ts` — Ed25519, base64
 * signature, the same JSON signature bases — because the Control Plane must
 * verify what the real gateway actually produces.
 */
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from 'node:crypto';

import type { WebSocket } from 'ws';

export interface TestDeviceIdentity {
  deviceId: string;
  gatewayId: string;
  publicKeyJwk: Record<string, unknown>;
  publicKeyPem: string;
  sign(data: string): string;
}

/** Generate a device identity with a real Ed25519 key pair. */
export function createTestIdentity(deviceId: string, gatewayId: string): TestDeviceIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  });

  const privateKeyObj = createPrivateKey(privateKey);
  const publicKeyObj = createPublicKey(publicKey);
  const publicKeyJwk = publicKeyObj.export({ format: 'jwk' }) as Record<string, unknown>;

  return {
    deviceId,
    gatewayId,
    publicKeyJwk,
    publicKeyPem: publicKey,
    // Ed25519 signs the message directly, so the digest argument is null.
    sign: (data: string) => sign(null, Buffer.from(data, 'utf8'), privateKeyObj).toString('base64'),
  };
}

/** The fields a device record needs to be able to authenticate. */
export function deviceRecordFor(
  identity: TestDeviceIdentity,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: identity.deviceId,
    gatewayId: identity.gatewayId,
    userId: 'usr_owner',
    friendlyName: 'Test Workstation',
    platform: 'linux',
    publicKeyPem: identity.publicKeyPem,
    publicKeyJwk: identity.publicKeyJwk,
    fingerprintHex: 'HEX1234',
    fingerprintWords: ['apple', 'banana'],
    status: 'trusted',
    ...overrides,
  };
}

function initialAuthPayload(identity: TestDeviceIdentity, connectionId: string) {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const timestamp = new Date().toISOString();
  const signatureBase = JSON.stringify({
    deviceId: identity.deviceId,
    gatewayId: identity.gatewayId,
    nonce,
    timestamp,
    certificateThumbprint: '',
  });

  return {
    deviceId: identity.deviceId,
    gatewayId: identity.gatewayId,
    connectionId,
    nonce,
    timestamp,
    publicKeyJwk: identity.publicKeyJwk,
    signature: identity.sign(signatureBase),
  };
}

export interface HandshakeResult {
  /** The auth_success message, or the auth_failure that ended the attempt. */
  message: Record<string, unknown>;
  ok: boolean;
}

/**
 * Drive the full two-step handshake on an already-open socket.
 *
 * Resolves on whichever terminal message arrives, so a test asserting a
 * rejection gets the failure rather than hanging until the suite times out.
 */
export function performHandshake(
  ws: WebSocket,
  identity: TestDeviceIdentity,
  options: { connectionId?: string; timeoutMs?: number } = {},
): Promise<HandshakeResult> {
  const connectionId = options.connectionId ?? 'default';
  const timeoutMs = options.timeoutMs ?? 5_000;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for the tunnel handshake to settle')),
      timeoutMs,
    );

    const onMessage = (data: Buffer | string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      } catch {
        return;
      }

      if (msg['type'] === 'auth_challenge') {
        const payload = msg['payload'] as {
          challenge: string;
          serverNonce: string;
          issuedAt: string;
        };
        const signatureBase = JSON.stringify({
          challenge: payload.challenge,
          serverNonce: payload.serverNonce,
          issuedAt: payload.issuedAt,
        });
        ws.send(
          JSON.stringify({
            id: 'challenge_response',
            type: 'auth',
            sequence: 2,
            timestamp: new Date().toISOString(),
            payload: {
              challenge: payload.challenge,
              serverNonce: payload.serverNonce,
              deviceId: identity.deviceId,
              signature: identity.sign(signatureBase),
            },
          }),
        );
        return;
      }

      if (msg['type'] === 'auth_success' || msg['type'] === 'auth_failure') {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve({ message: msg, ok: msg['type'] === 'auth_success' });
      }
    };

    ws.on('message', onMessage);

    ws.send(
      JSON.stringify({
        id: 'auth_init',
        type: 'auth',
        sequence: 1,
        timestamp: new Date().toISOString(),
        payload: initialAuthPayload(identity, connectionId),
      }),
    );
  });
}

/** Open a socket, authenticate it, and fail loudly if the handshake is refused. */
export async function connectAuthenticatedGateway(
  WebSocketImpl: new (url: string) => WebSocket,
  tunnelUrl: string,
  identity: TestDeviceIdentity,
  options: { connectionId?: string } = {},
): Promise<WebSocket> {
  const ws = new WebSocketImpl(tunnelUrl);
  await new Promise<void>((resolve) => ws.on('open', () => resolve()));

  const result = await performHandshake(ws, identity, options);
  if (!result.ok) {
    const payload = result.message['payload'] as { code?: string; reason?: string } | undefined;
    throw new Error(
      `Gateway handshake was refused: ${payload?.code ?? 'unknown'} — ${payload?.reason ?? ''}`,
    );
  }
  return ws;
}

/**
 * Verification of gateway-produced signatures.
 *
 * The gateway signs with `DeviceIdentityManager` (gateway/identity), which uses
 * Ed25519 by default and P-256 otherwise, and encodes signatures as base64.
 * This module is the Control Plane's half of that: it must derive the digest
 * algorithm the same way the signer did, because Node's `verify()` silently
 * returns false on a mismatch rather than telling you the algorithm was wrong.
 *
 * Deriving it from the key itself — rather than from a field in the message —
 * is deliberate. An attacker controls the message; they do not control the
 * stored public key, so the algorithm cannot be downgraded by an attacker who
 * simply claims a weaker one.
 */
import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';

/**
 * Ed25519 signs the message directly (no separate digest), so Node wants
 * `null` for the algorithm. Everything else here is EC P-256 with SHA-512,
 * matching `DeviceIdentityManager.sign`.
 */
function digestAlgorithmFor(jwk: Record<string, unknown>): string | null {
  const kty = typeof jwk['kty'] === 'string' ? jwk['kty'] : '';
  const crv = typeof jwk['crv'] === 'string' ? jwk['crv'] : '';
  if (kty === 'OKP' && crv === 'Ed25519') return null;
  return 'sha512';
}

export function isUsablePublicKeyJwk(jwk: unknown): jwk is Record<string, unknown> {
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return false;
  const record = jwk as Record<string, unknown>;
  const kty = record['kty'];
  if (typeof kty !== 'string' || kty.length === 0) return false;
  // A JWK carrying a private component must never be accepted as a device's
  // public key: it would mean the Control Plane could forge that device.
  if (typeof record['d'] === 'string') return false;
  return true;
}

function toKeyObject(jwk: Record<string, unknown>): KeyObject | null {
  try {
    return createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
  } catch {
    return null;
  }
}

/**
 * Verify `signature` (base64) over `data` using a device's stored public JWK.
 *
 * Returns false for every failure mode — malformed key, malformed signature,
 * wrong algorithm, bad signature — and never throws. A verification helper that
 * throws on malformed input invites a caller to wrap it in a try/catch whose
 * catch block accidentally treats an error as success.
 */
export function verifyDeviceSignature(
  data: string,
  signature: string,
  publicKeyJwk: unknown,
): boolean {
  if (!signature || typeof signature !== 'string') return false;
  if (!isUsablePublicKeyJwk(publicKeyJwk)) return false;

  const keyObject = toKeyObject(publicKeyJwk);
  if (!keyObject) return false;

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  if (signatureBytes.length === 0) return false;

  try {
    return verify(
      digestAlgorithmFor(publicKeyJwk),
      Buffer.from(data, 'utf8'),
      keyObject,
      signatureBytes,
    );
  } catch {
    return false;
  }
}

/**
 * The exact string the gateway signs for the initial `auth` payload.
 * Mirrors `TunnelClient.sendAuth` — key order is part of the contract, because
 * both sides sign a JSON string rather than a canonical form.
 */
export function initialAuthSignatureBase(input: {
  deviceId: string;
  gatewayId: string;
  nonce: string;
  timestamp: string;
  certificateThumbprint?: string | undefined;
}): string {
  return JSON.stringify({
    deviceId: input.deviceId,
    gatewayId: input.gatewayId,
    nonce: input.nonce,
    timestamp: input.timestamp,
    certificateThumbprint: input.certificateThumbprint ?? '',
  });
}

/**
 * The exact string the gateway signs in response to `auth_challenge`.
 * Mirrors `TunnelClient.handleAuthChallenge`.
 */
export function challengeSignatureBase(input: {
  challenge: string;
  serverNonce: string;
  issuedAt: string;
}): string {
  return JSON.stringify({
    challenge: input.challenge,
    serverNonce: input.serverNonce,
    issuedAt: input.issuedAt,
  });
}

/**
 * The exact string `pnpm pair` signs when it registers a pairing code.
 *
 * Registering a code proves nothing on its own: device ids are shown in the
 * UI, so anyone could register a code naming someone else's device. Signing
 * the registration with the device key is what lets a re-pair move an existing
 * device to a new account — only the machine that holds the key can ask for it.
 */
export function pairingSignatureBase(input: {
  code: string;
  deviceId: string;
  gatewayId: string;
  timestamp: string;
}): string {
  return JSON.stringify({
    purpose: 'odysseus.pairing.v1',
    code: input.code,
    deviceId: input.deviceId,
    gatewayId: input.gatewayId,
    timestamp: input.timestamp,
  });
}

/**
 * Whether two public JWKs are the same key. Compares only the members that
 * define the key, so optional metadata (`kid`, `use`, `alg`) cannot make a
 * different key look equal, or the same key look different.
 */
export function isSameDeviceKey(a: unknown, b: unknown): boolean {
  if (!isUsablePublicKeyJwk(a) || !isUsablePublicKeyJwk(b)) return false;
  const members = ['kty', 'crv', 'x', 'y', 'n', 'e'] as const;
  return members.every((member) => a[member] === b[member]) && typeof a['kty'] === 'string';
}

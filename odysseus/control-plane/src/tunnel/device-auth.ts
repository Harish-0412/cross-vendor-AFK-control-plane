/**
 * Gateway tunnel authentication.
 *
 * The gateway proves it holds the private key for a paired device. Possession
 * of a device id proves nothing — device ids appear in API responses, in the
 * UI and in logs, so treating one as a credential means anyone who has seen a
 * screenshot can impersonate a workstation.
 *
 * The exchange, which is the one the gateway's TunnelClient already implements:
 *
 *   1. gateway → `auth`            signed over {deviceId, gatewayId, nonce,
 *                                   timestamp, certificateThumbprint}
 *   2. server  → `auth_challenge`  {challenge, serverNonce, issuedAt, expiresAt}
 *   3. gateway → `auth`            signed over {challenge, serverNonce, issuedAt}
 *   4. server  → `auth_success`
 *
 * Step 1 alone is replayable — an attacker who captured it can resend it
 * verbatim. Step 3 is what makes that useless: the challenge is server-chosen,
 * single-use and bound to this socket, so a replayed step 1 earns a challenge
 * the attacker cannot sign.
 */
import { randomBytes } from 'node:crypto';

import {
  challengeSignatureBase,
  initialAuthSignatureBase,
  isUsablePublicKeyJwk,
  verifyDeviceSignature,
} from '../auth/device-signature';

/** How far a client's auth timestamp may drift from ours before we refuse it. */
export const DEFAULT_CLOCK_SKEW_TOLERANCE_MS = 120_000;
/** How long an issued challenge stays answerable. */
export const DEFAULT_CHALLENGE_TTL_MS = 30_000;

export interface PendingChallenge {
  challenge: string;
  serverNonce: string;
  /** The exact ISO string sent to the client; it is part of the signed base. */
  issuedAtIso: string;
  expiresAt: number;
  deviceId: string;
  gatewayId: string;
  connectionId: string;
}

export interface InitialAuthInput {
  deviceId: string;
  gatewayId: string;
  connectionId: string;
  nonce: string;
  timestamp: string;
  certificateThumbprint?: string | undefined;
  signature: string;
}

export type AuthDenial = {
  ok: false;
  code:
    | 'INVALID_CREDENTIALS'
    | 'DEVICE_NOT_TRUSTED'
    | 'DEVICE_REVOKED'
    | 'DEVICE_KEY_MISSING'
    | 'CLOCK_SKEW'
    | 'REPLAYED_NONCE'
    | 'SIGNATURE_INVALID'
    | 'CHALLENGE_EXPIRED'
    | 'CHALLENGE_MISMATCH';
  reason: string;
  retryable: boolean;
  /** Whether the socket should be closed rather than left open to retry. */
  fatal: boolean;
};

export type InitialAuthResult = AuthDenial | { ok: true; challenge: PendingChallenge };
export type ChallengeResult = AuthDenial | { ok: true };

export interface DeviceAuthenticatorOptions {
  clockSkewToleranceMs?: number;
  challengeTtlMs?: number;
  now?: () => number;
}

/**
 * Remembers recently used client nonces so an identical step-1 payload cannot
 * be replayed within the freshness window. Bounded, and pruned by expiry, so a
 * flood of connection attempts cannot grow it without limit.
 */
class NonceCache {
  private readonly entries = new Map<string, number>();

  constructor(private readonly maxEntries = 10_000) {}

  /** Returns false when the nonce has been seen and is still within its window. */
  admit(key: string, expiresAt: number, now: number): boolean {
    this.prune(now);
    if (this.entries.has(key)) return false;
    if (this.entries.size >= this.maxEntries) {
      // Drop the oldest insertion rather than refusing new connections: a full
      // cache must degrade replay protection, never availability.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, expiresAt);
    return true;
  }

  private prune(now: number): void {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(key);
      else break; // Map preserves insertion order and all TTLs are equal.
    }
  }
}

export class DeviceAuthenticator {
  private readonly clockSkewToleranceMs: number;
  private readonly challengeTtlMs: number;
  private readonly now: () => number;
  private readonly nonces = new NonceCache();

  constructor(options: DeviceAuthenticatorOptions = {}) {
    this.clockSkewToleranceMs = options.clockSkewToleranceMs ?? DEFAULT_CLOCK_SKEW_TOLERANCE_MS;
    this.challengeTtlMs = options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Validate step 1 and, on success, mint the challenge for step 3.
   *
   * `storedPublicKeyJwk` is the key recorded for this device at pairing time.
   * The key presented in the auth payload is deliberately ignored for
   * verification — trusting it would mean any attacker could bring their own
   * key pair and sign their own way in.
   */
  beginAuth(input: InitialAuthInput, storedPublicKeyJwk: unknown): InitialAuthResult {
    if (!input.deviceId || !input.gatewayId) {
      return {
        ok: false,
        code: 'INVALID_CREDENTIALS',
        reason: 'Missing deviceId or gatewayId',
        retryable: false,
        fatal: true,
      };
    }

    if (!isUsablePublicKeyJwk(storedPublicKeyJwk)) {
      return {
        ok: false,
        code: 'DEVICE_KEY_MISSING',
        reason:
          'No public key is recorded for this device, so its identity cannot be verified. ' +
          'Re-pair the gateway to register its key.',
        retryable: false,
        fatal: true,
      };
    }

    if (!input.signature || !input.nonce || !input.timestamp) {
      return {
        ok: false,
        code: 'SIGNATURE_INVALID',
        reason: 'Auth payload is missing nonce, timestamp or signature',
        retryable: false,
        fatal: true,
      };
    }

    const parsedTimestamp = Date.parse(input.timestamp);
    if (Number.isNaN(parsedTimestamp)) {
      return {
        ok: false,
        code: 'CLOCK_SKEW',
        reason: 'Auth timestamp is not a valid date',
        retryable: false,
        fatal: true,
      };
    }

    const now = this.now();
    if (Math.abs(now - parsedTimestamp) > this.clockSkewToleranceMs) {
      // Retryable: the usual cause is a workstation clock that is genuinely
      // wrong, which the user can fix, rather than an attack.
      return {
        ok: false,
        code: 'CLOCK_SKEW',
        reason:
          `Auth timestamp is ${Math.round(Math.abs(now - parsedTimestamp) / 1000)}s from ` +
          'server time; check the workstation clock',
        retryable: true,
        fatal: false,
      };
    }

    if (
      !this.nonces.admit(`${input.deviceId}:${input.nonce}`, now + this.clockSkewToleranceMs, now)
    ) {
      return {
        ok: false,
        code: 'REPLAYED_NONCE',
        reason: 'This auth nonce has already been used',
        retryable: false,
        fatal: true,
      };
    }

    const base = initialAuthSignatureBase({
      deviceId: input.deviceId,
      gatewayId: input.gatewayId,
      nonce: input.nonce,
      timestamp: input.timestamp,
      certificateThumbprint: input.certificateThumbprint,
    });

    if (!verifyDeviceSignature(base, input.signature, storedPublicKeyJwk)) {
      return {
        ok: false,
        code: 'SIGNATURE_INVALID',
        reason: 'Auth signature does not match the key registered for this device',
        retryable: false,
        fatal: true,
      };
    }

    const issuedAt = new Date(now);
    return {
      ok: true,
      challenge: {
        challenge: randomBytes(32).toString('hex'),
        serverNonce: randomBytes(16).toString('hex'),
        issuedAtIso: issuedAt.toISOString(),
        expiresAt: now + this.challengeTtlMs,
        deviceId: input.deviceId,
        gatewayId: input.gatewayId,
        connectionId: input.connectionId,
      },
    };
  }

  /** Validate step 3 against the challenge issued on this socket. */
  completeAuth(
    pending: PendingChallenge,
    response: {
      challenge?: unknown;
      serverNonce?: unknown;
      signature?: unknown;
      deviceId?: unknown;
    },
    storedPublicKeyJwk: unknown,
  ): ChallengeResult {
    if (this.now() > pending.expiresAt) {
      return {
        ok: false,
        code: 'CHALLENGE_EXPIRED',
        reason: 'Challenge expired before a response arrived',
        retryable: true,
        fatal: true,
      };
    }

    const challenge = typeof response.challenge === 'string' ? response.challenge : '';
    const serverNonce = typeof response.serverNonce === 'string' ? response.serverNonce : '';
    const signature = typeof response.signature === 'string' ? response.signature : '';
    const deviceId = typeof response.deviceId === 'string' ? response.deviceId : '';

    // Constant-time comparison is unnecessary here: the challenge is random,
    // single-use and short-lived, so a timing oracle yields nothing reusable.
    if (
      challenge !== pending.challenge ||
      serverNonce !== pending.serverNonce ||
      (deviceId && deviceId !== pending.deviceId)
    ) {
      return {
        ok: false,
        code: 'CHALLENGE_MISMATCH',
        reason: 'Challenge response does not match the challenge issued on this connection',
        retryable: false,
        fatal: true,
      };
    }

    const base = challengeSignatureBase({
      challenge: pending.challenge,
      serverNonce: pending.serverNonce,
      issuedAt: pending.issuedAtIso,
    });

    if (!verifyDeviceSignature(base, signature, storedPublicKeyJwk)) {
      return {
        ok: false,
        code: 'SIGNATURE_INVALID',
        reason: 'Challenge signature does not match the key registered for this device',
        retryable: false,
        fatal: true,
      };
    }

    return { ok: true };
  }
}

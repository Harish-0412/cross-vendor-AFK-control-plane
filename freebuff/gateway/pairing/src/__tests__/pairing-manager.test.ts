import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createDeviceIdentityManager } from '@freebuff/identity';
import type { DeviceCertificate, PairingCode } from '@freebuff/protocol';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { PairingRateLimiter, createPairingRateLimiter } from '../code-generator';
import {
  PairingManager,
  createPairingManager,
  type ControlPlanePairingClient,
  type PairingEvent,
} from '../pairing-manager';
import { PAIRING_CODE_LENGTH } from '../types';

function createMockClient(
  overrides: Partial<ControlPlanePairingClient> = {},
): ControlPlanePairingClient {
  return {
    checkPairingStatus: vi.fn().mockResolvedValue({
      success: false,
      deviceTrusted: false,
      requiresFingerprintConfirm: false,
      message: 'pending',
    }),
    confirmFingerprint: vi.fn().mockResolvedValue({
      success: true,
      deviceTrusted: true,
      requiresFingerprintConfirm: false,
      message: 'confirmed',
    }),
    requestDeviceCertificate: vi.fn().mockResolvedValue({
      id: 'cert_test123',
      deviceId: 'dev_test123',
      certificatePem: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
      serialNumber: 'ABC123',
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      issuer: 'CN=Freebuff Device CA',
      subject: 'CN=Device test',
      thumbprint: 'thumbprint123',
      signatureAlgorithm: 'SHA256withECDSA',
    } satisfies DeviceCertificate),
    ...overrides,
  };
}

describe('PairingManager', () => {
  let tmpDir: string;
  let identityManager: ReturnType<typeof createDeviceIdentityManager>;
  let manager: PairingManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'freebuff-pairing-test-'));
    identityManager = createDeviceIdentityManager({
      storage: { storageDir: tmpDir, keyFileName: `keys-${Date.now()}.json` },
    });
    await identityManager.initialize();
  });

  afterEach(async () => {
    await manager?.shutdown().catch(() => {});
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('should initialize with idle state', () => {
    manager = createPairingManager(identityManager);
    expect(manager.getState()).toBe('idle');
    expect(manager.getCurrentSession()).toBeNull();
  });

  it('should start pairing and return confirmation', async () => {
    manager = createPairingManager(identityManager);
    const confirmation = await manager.startPairing();

    expect(confirmation.code).toHaveLength(PAIRING_CODE_LENGTH);
    expect(confirmation.fingerprintWords.length).toBeGreaterThan(0);
    expect(confirmation.fingerprintShort.length).toBeGreaterThan(0);
    expect(confirmation.qrPayload.length).toBeGreaterThan(0);
    expect(confirmation.expiresAt).toBeInstanceOf(Date);
    expect(confirmation.expiresInSeconds).toBeGreaterThan(0);

    const session = manager.getCurrentSession();
    expect(session).not.toBeNull();
    expect(session!.state).toBe('awaiting_user_input');
  });

  it('should transition state correctly through pairing', async () => {
    manager = createPairingManager(identityManager);
    const events: PairingEvent[] = [];
    manager.onEvent((e) => events.push(e));

    await manager.startPairing();

    expect(events.some((e) => e.type === 'session_created')).toBe(true);
    expect(events.some((e) => e.type === 'code_display')).toBe(true);
    expect(manager.getState()).toBe('awaiting_user_input');
  });

  it('should cancel pairing', async () => {
    manager = createPairingManager(identityManager);
    const events: PairingEvent[] = [];
    manager.onEvent((e) => events.push(e));

    await manager.startPairing();
    expect(manager.getCurrentSession()).not.toBeNull();

    await manager.cancelPairing('User cancelled');
    expect(manager.getState()).toBe('idle');
    expect(manager.getCurrentSession()).toBeNull();
    expect(events.some((e) => e.type === 'session_cancelled')).toBe(true);
  });

  it('should allow starting new pairing after cancellation', async () => {
    manager = createPairingManager(identityManager);

    await manager.startPairing();
    const firstCode = manager.getCurrentSession()?.code;
    await manager.cancelPairing();

    const secondConfirmation = await manager.startPairing();
    expect(secondConfirmation.code).toBeTruthy();
    expect(secondConfirmation.code).not.toBe(firstCode);
  });

  it('should handle manual fingerprint confirmation (offline mode)', async () => {
    manager = createPairingManager(identityManager);
    // No control plane client → offline mode
    const events: PairingEvent[] = [];
    manager.onEvent((e) => events.push(e));

    await manager.startPairing();
    manager.startPolling();

    const confirmed = await manager.confirmFingerprintManually();
    expect(confirmed).toBe(true);
    expect(events.some((e) => e.type === 'pairing_success')).toBe(true);
  });

  it('should handle control plane pairing success', async () => {
    manager = createPairingManager(identityManager, { pollIntervalMs: 20 });
    const client = createMockClient({
      checkPairingStatus: vi.fn().mockResolvedValue({
        success: true,
        deviceTrusted: true,
        requiresFingerprintConfirm: false,
        message: 'trusted',
      }),
    });
    manager.setControlPlaneClient(client);

    const events: PairingEvent[] = [];
    manager.onEvent((e) => events.push(e));

    await manager.startPairing();
    manager.startPolling();

    // Wait for the poll cycle (short interval + buffer)
    await new Promise((r) => setTimeout(r, 200));

    expect(manager.getState()).toBe('idle'); // paired, session cleared
    expect(events.some((e) => e.type === 'pairing_success')).toBe(true);
  });

  it('should handle control plane fingerprint confirmation required', async () => {
    manager = createPairingManager(identityManager, { pollIntervalMs: 20 });
    const client = createMockClient({
      checkPairingStatus: vi.fn().mockResolvedValue({
        success: true,
        deviceTrusted: false,
        requiresFingerprintConfirm: true,
        message: 'confirm fingerprint',
      }),
    });
    manager.setControlPlaneClient(client);

    await manager.startPairing();

    const events: PairingEvent[] = [];
    manager.onEvent((e) => events.push(e));

    manager.startPolling();
    await new Promise((r) => setTimeout(r, 200));

    expect(manager.getState()).toBe('awaiting_fingerprint_confirm');
    expect(events.some((e) => e.type === 'fingerprint_confirm_required')).toBe(true);
  });

  it('should enforce rate limiting', async () => {
    const rateLimiter = createPairingRateLimiter({
      windowMs: 60_000,
      maxCodesPerWindow: 2,
      maxAttempts: 10,
    });
    manager = new PairingManager(identityManager, {}, rateLimiter);

    await manager.startPairing();
    await manager.cancelPairing();
    await manager.startPairing();
    await manager.cancelPairing();

    // Third should be rate limited
    await expect(manager.startPairing()).rejects.toThrow(/too many/i);
  });

  it('should reject new pairing when one is already active', async () => {
    manager = createPairingManager(identityManager);

    const first = await manager.startPairing();
    const second = await manager.startPairing();

    // Should return the same confirmation since the existing session is still valid
    expect(second.code).toBe(first.code);
  });

  it('should emit events on listener subscribe/unsubscribe', async () => {
    manager = createPairingManager(identityManager);
    const events: PairingEvent[] = [];
    const unsub = manager.onEvent((e) => events.push(e));

    await manager.startPairing();
    expect(events.length).toBeGreaterThan(0);

    unsub();
    const countBefore = events.length;
    await manager.cancelPairing();
    // Should not receive the cancel event after unsubscribe
    expect(events.length).toBe(countBefore);
  });

  it('should handle shutdown gracefully', async () => {
    manager = createPairingManager(identityManager);
    await manager.startPairing();

    await manager.shutdown();
    expect(manager.getState()).toBe('idle');
  });
});

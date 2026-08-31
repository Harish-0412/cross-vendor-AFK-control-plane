import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  CertificateManager,
  createCertificateManager,
} from '../certificate-manager';
import type { SessionInvalidator } from '../certificate-manager';
import { createDeviceIdentityManager } from '@freebuff/identity';

describe('CertificateManager', () => {
  let tmpDir: string;
  let identityManager: ReturnType<typeof createDeviceIdentityManager>;
  let certManager: CertificateManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'freebuff-cert-test-'));
    identityManager = createDeviceIdentityManager({
      storage: { storageDir: tmpDir, keyFileName: `keys-${Date.now()}.json` },
    });
    await identityManager.initialize();
  });

  afterEach(async () => {
    await certManager?.shutdown().catch(() => {});
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('should initialize without a certificate', () => {
    certManager = createCertificateManager(identityManager, undefined, { useEmbeddedCAForTesting: true });
    expect(certManager.hasCertificate()).toBe(false);
    expect(certManager.getCurrentCertificate()).toBeNull();
    expect(certManager.isCertificateValidNow()).toBe(false);
  });

  it('should issue an initial certificate', async () => {
    certManager = createCertificateManager(identityManager, undefined, { useEmbeddedCAForTesting: true });

    const cert = await certManager.issueInitialCertificate();

    expect(cert.id).toMatch(/^cert_/);
    expect(cert.deviceId).toBe(identityManager.getIdentity().deviceId);
    expect(cert.certificatePem).toContain('BEGIN CERTIFICATE');
    expect(certManager.hasCertificate()).toBe(true);
    expect(certManager.isCertificateValidNow()).toBe(true);
    expect(certManager.needsRenewal()).toBe(false);
  });

  it('should renew certificate', async () => {
    certManager = createCertificateManager(identityManager, undefined, {
      useEmbeddedCAForTesting: true,
      autoRenew: false,
    });

    const oldCert = await certManager.issueInitialCertificate();
    const newCert = await certManager.renewCertificate();

    expect(newCert.id).not.toBe(oldCert.id);
    expect(newCert.thumbprint).not.toBe(oldCert.thumbprint);
    expect(certManager.getCurrentCertificate()?.id).toBe(newCert.id);
  });

  it('should emit renewal events', async () => {
    certManager = createCertificateManager(identityManager, undefined, {
      useEmbeddedCAForTesting: true,
      autoRenew: false,
    });

    const renewalListener = vi.fn();
    certManager.onRenewal(renewalListener);

    await certManager.issueInitialCertificate();
    await certManager.renewCertificate();

    expect(renewalListener).toHaveBeenCalledTimes(1);
  });

  it('should check revocation', async () => {
    certManager = createCertificateManager(identityManager, undefined, { useEmbeddedCAForTesting: true });

    await certManager.issueInitialCertificate();

    // Device is not revoked
    const isRevoked = await certManager.checkRevocation();
    expect(isRevoked).toBe(false);
  });

  it('should emit revocation events when device is revoked', async () => {
    const mockInvalidator: SessionInvalidator = {
      pauseAllSessions: vi.fn().mockResolvedValue(undefined),
    };

    certManager = createCertificateManager(identityManager, mockInvalidator, {
      useEmbeddedCAForTesting: true,
    });

    const revocationListener = vi.fn();
    certManager.onRevocation(revocationListener);

    await certManager.issueInitialCertificate();

    // Simulate revocation via the store
    const store = certManager.getRevocationStore();
    store.add({
      deviceId: identityManager.getIdentity().deviceId,
      revokedAt: new Date(),
      reason: 'compromise_suspected',
      revokedBy: 'admin',
      affectedCertificates: [],
      effectiveImmediately: true,
    });

    expect(revocationListener).toHaveBeenCalled();
  });

  it('should get certificate chain', async () => {
    certManager = createCertificateManager(identityManager, undefined, { useEmbeddedCAForTesting: true });

    await certManager.issueInitialCertificate();
    const chain = certManager.getCertificateChain();

    expect(chain).not.toBeNull();
    expect(chain!.leaf).toBeDefined();
    expect(chain!.root).toBeDefined();
    expect(chain!.intermediate).toBeDefined();
  });

  it('should get embedded CA root PEM for testing', async () => {
    certManager = createCertificateManager(identityManager, undefined, { useEmbeddedCAForTesting: true });
    // Embedded CA is created in constructor, so PEM is available immediately
    expect(certManager.getEmbeddedCARootPem()).toContain('BEGIN CERTIFICATE');

    await certManager.issueInitialCertificate();
    expect(certManager.getEmbeddedCARootPem()).toContain('BEGIN CERTIFICATE');
  });

  it('should reject issuance without CA or client', async () => {
    certManager = createCertificateManager(identityManager, undefined, {
      useEmbeddedCAForTesting: false,
    });

    await expect(certManager.issueInitialCertificate()).rejects.toThrow(/no ca available/i);
  });

  it('should shutdown cleanly', async () => {
    certManager = createCertificateManager(identityManager, undefined, {
      useEmbeddedCAForTesting: true,
      autoRenew: true,
    });
    await certManager.issueInitialCertificate();
    await certManager.shutdown();
    // Should not throw
  });
});

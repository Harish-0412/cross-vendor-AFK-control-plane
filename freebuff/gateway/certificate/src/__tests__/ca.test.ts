import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createDeviceIdentityManager } from '@freebuff/identity';
import { DeviceIdentity } from '@freebuff/protocol';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  generateCAKeyMaterial,
  type CertificateAuthority,
  createCertificateAuthority,
  DEFAULT_ROOT_CA_CONFIG,
  DEFAULT_INTERMEDIATE_CA_CONFIG,
  type CertificateSigningRequest,
} from '../ca';

describe('generateCAKeyMaterial', () => {
  it('should generate EC key material by default', () => {
    const key = generateCAKeyMaterial();
    expect(key.algorithm).toBe('EC');
    expect(key.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(key.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(typeof key.privateKeyJwk).toBe('object');
    expect(typeof key.publicKeyJwk).toBe('object');
  });

  it('should generate RSA key material when specified', () => {
    const key = generateCAKeyMaterial('RSA', 2048);
    expect(key.algorithm).toBe('RSA');
    expect(key.curveOrModulus).toBe(2048);
    expect(key.privateKeyPem).toContain('BEGIN PRIVATE KEY');
  });

  it('should produce different keys on each call', () => {
    const key1 = generateCAKeyMaterial();
    const key2 = generateCAKeyMaterial();
    expect(key1.privateKeyPem).not.toBe(key2.privateKeyPem);
    expect(key1.publicKeyPem).not.toBe(key2.publicKeyPem);
  });
});

describe('CertificateAuthority', () => {
  let rootKey: ReturnType<typeof generateCAKeyMaterial>;
  let intermediateKey: ReturnType<typeof generateCAKeyMaterial>;
  let ca: CertificateAuthority;
  let twoLevelCA: CertificateAuthority;

  beforeEach(() => {
    rootKey = generateCAKeyMaterial('EC', 'prime256v1');
    intermediateKey = generateCAKeyMaterial('EC', 'prime256v1');
    ca = createCertificateAuthority(rootKey, DEFAULT_ROOT_CA_CONFIG);
    twoLevelCA = createCertificateAuthority(
      rootKey,
      DEFAULT_ROOT_CA_CONFIG,
      intermediateKey,
      DEFAULT_INTERMEDIATE_CA_CONFIG,
    );
  });

  it('should have root certificate PEM', () => {
    expect(ca.getRootCertificatePem()).toContain('BEGIN CERTIFICATE');
    expect(ca.getIntermediateCertificatePem()).toBeUndefined();
  });

  it('should have intermediate certificate PEM in two-level CA', () => {
    expect(twoLevelCA.getRootCertificatePem()).toContain('BEGIN CERTIFICATE');
    expect(twoLevelCA.getIntermediateCertificatePem()).toContain('BEGIN CERTIFICATE');
  });

  it('should issue a device certificate', () => {
    const csr: CertificateSigningRequest = {
      deviceId: 'dev_test1234567890abcdef12345678',
      gatewayId: 'gw_test1234567890abcdef',
      publicKeyPem: rootKey.publicKeyPem,
      deviceFingerprintHex: 'aabbccdd',
      validityMs: 24 * 60 * 60 * 1000,
      signedChallenge: { nonce: 'abc123', signature: 'sig123' },
    };

    const cert = ca.issueDeviceCertificate(csr);

    expect(cert.id).toMatch(/^cert_/);
    expect(cert.deviceId).toBe(csr.deviceId);
    expect(cert.certificatePem).toContain('BEGIN CERTIFICATE');
    expect(cert.serialNumber).toMatch(/^[A-F0-9]+$/);
    expect(cert.issuedAt).toBeInstanceOf(Date);
    expect(cert.expiresAt).toBeInstanceOf(Date);
    expect(cert.expiresAt.getTime()).toBeGreaterThan(cert.issuedAt.getTime());
    expect(cert.thumbprint).toMatch(/^[a-f0-9]+$/);
    expect(cert.signatureAlgorithm).toBeTruthy();
  });

  it('should verify a valid device certificate', () => {
    const csr: CertificateSigningRequest = {
      deviceId: 'dev_test1234567890abcdef12345678',
      gatewayId: 'gw_test1234567890abcdef',
      publicKeyPem: rootKey.publicKeyPem,
      deviceFingerprintHex: 'aabbccdd',
      signedChallenge: { nonce: 'nonce', signature: 'sig' },
    };

    const cert = ca.issueDeviceCertificate(csr);
    const result = ca.verifyDeviceCertificate(cert.certificatePem);

    expect(result.valid).toBe(true);
    expect(result.thumbprint).toBe(cert.thumbprint);
  });

  it('should get certificate chain (single-level)', () => {
    const csr: CertificateSigningRequest = {
      deviceId: 'dev_test1234567890abcdef12345678',
      gatewayId: 'gw_test1234567890abcdef',
      publicKeyPem: rootKey.publicKeyPem,
      deviceFingerprintHex: 'aabbccdd',
      signedChallenge: { nonce: 'n', signature: 's' },
    };

    const cert = ca.issueDeviceCertificate(csr);
    const chain = ca.getCertificateChain(cert);

    expect(chain.leaf.id).toBe(cert.id);
    expect(chain.root.certificatePem).toContain('BEGIN CERTIFICATE');
    expect(chain.intermediate).toBeUndefined();
  });

  it('should get certificate chain (two-level)', () => {
    const csr: CertificateSigningRequest = {
      deviceId: 'dev_test1234567890abcdef12345678',
      gatewayId: 'gw_test1234567890abcdef',
      publicKeyPem: intermediateKey.publicKeyPem,
      deviceFingerprintHex: 'aabbccdd',
      signedChallenge: { nonce: 'n', signature: 's' },
    };

    const cert = twoLevelCA.issueDeviceCertificate(csr);
    const chain = twoLevelCA.getCertificateChain(cert);

    expect(chain.leaf.id).toBe(cert.id);
    expect(chain.root.certificatePem).toContain('BEGIN CERTIFICATE');
    expect(chain.intermediate).toBeDefined();
    expect(chain.intermediate!.certificatePem).toContain('BEGIN CERTIFICATE');
  });

  it('should reject invalid certificate PEM', () => {
    const result = ca.verifyDeviceCertificate('not-a-cert');
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

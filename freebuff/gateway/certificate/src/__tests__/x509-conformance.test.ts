import { X509Certificate, createPublicKey } from 'node:crypto';

import { describe, it, expect } from 'vitest';

import {
  generateCAKeyMaterial,
  createCertificateAuthority,
  DEFAULT_ROOT_CA_CONFIG,
  DEFAULT_INTERMEDIATE_CA_CONFIG,
} from '../ca';

/**
 * Verifies the hand-rolled DER encoder against Node's native X.509
 * implementation rather than against its own decoding logic.
 *
 * The package's other tests round-trip certificates through the same code that
 * produced them, so they stayed green while every issued certificate was in
 * fact unverifiable: the SubjectPublicKeyInfo was double-wrapped, the KeyUsage
 * BIT STRING declared 7 unused bits so the keyCertSign bit fell inside the
 * padding, and `verifyDeviceCertificate` compensated by comparing issuer and
 * subject *strings* instead of checking a signature. OpenSSL is the independent
 * authority here — if these assertions pass, the certificates are real.
 */
describe('X.509 conformance (verified against node:crypto)', () => {
  function buildCa() {
    const rootKey = generateCAKeyMaterial('EC', 'prime256v1');
    return { rootKey, ca: createCertificateAuthority(rootKey, DEFAULT_ROOT_CA_CONFIG) };
  }

  function issueDevice(
    ca: ReturnType<typeof createCertificateAuthority>,
    deviceId = 'dev_abc123def456',
  ) {
    const deviceKey = generateCAKeyMaterial('EC', 'prime256v1');
    const cert = ca.issueDeviceCertificate({
      deviceId,
      gatewayId: '',
      publicKeyPem: deviceKey.publicKeyPem,
      deviceFingerprintHex: 'aabbccdd',
      signedChallenge: { nonce: 'nonce', signature: 'sig' },
    });
    return { deviceKey, cert };
  }

  it('produces a root certificate OpenSSL can parse and self-verify', () => {
    const { ca } = buildCa();
    const root = new X509Certificate(ca.getRootCertificatePem());

    expect(root.ca).toBe(true);
    // Self-signed: the root's own key must validate its signature.
    expect(root.verify(root.publicKey)).toBe(true);
  });

  it('signs device certificates that verify against the CA public key', () => {
    const { ca } = buildCa();
    const root = new X509Certificate(ca.getRootCertificatePem());
    const { cert } = issueDevice(ca);
    const device = new X509Certificate(cert.certificatePem);

    expect(device.verify(root.publicKey)).toBe(true);
    // Direction matters: "was the device issued by the root?"
    expect(device.checkIssued(root)).toBe(true);
    expect(device.ca).toBe(false);
  });

  it('embeds exactly the public key that was presented in the CSR', () => {
    const { ca } = buildCa();
    const { deviceKey, cert } = issueDevice(ca);
    const device = new X509Certificate(cert.certificatePem);

    const embedded = device.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const requested = createPublicKey(deviceKey.publicKeyPem)
      .export({ type: 'spki', format: 'pem' })
      .toString();

    // A double-wrapped SubjectPublicKeyInfo silently changes the embedded key.
    expect(embedded).toBe(requested);
  });

  it('grants the CA keyCertSign so it is allowed to issue certificates', () => {
    const { ca } = buildCa();
    const root = new X509Certificate(ca.getRootCertificatePem());
    const { cert } = issueDevice(ca);
    const device = new X509Certificate(cert.certificatePem);

    // checkIssued fails with KEYUSAGE_NO_CERTSIGN when the issuer's KeyUsage
    // extension is present but omits keyCertSign — which is what a wrong
    // unused-bits count produces.
    expect(device.checkIssued(root)).toBe(true);
  });

  it('accepts a genuine device certificate', () => {
    const { ca } = buildCa();
    const { cert } = issueDevice(ca);

    const result = ca.verifyDeviceCertificate(cert.certificatePem);
    expect(result.valid).toBe(true);
    expect(result.thumbprint).toBe(cert.thumbprint);
    expect(result.deviceId).toBe('dev_abc123def456');
  });

  it('rejects a self-signed certificate that merely claims the CA as its issuer', () => {
    // The core impersonation case. This certificate carries a correct-looking
    // issuer name but is signed by an attacker's key, so a name comparison
    // accepts it and a signature check does not.
    const { ca } = buildCa();
    const attackerKey = generateCAKeyMaterial('EC', 'prime256v1');
    const attackerCa = createCertificateAuthority(attackerKey, DEFAULT_ROOT_CA_CONFIG);
    const { cert: forged } = issueDevice(attackerCa);

    const forgedX509 = new X509Certificate(forged.certificatePem);
    const realRoot = new X509Certificate(ca.getRootCertificatePem());

    // Same issuer string as the real CA — this is what made the old check pass.
    expect(forgedX509.issuer).toBe(realRoot.subject);

    const result = ca.verifyDeviceCertificate(forged.certificatePem);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/not signed by trusted CA/i);
  });

  it('rejects a CA certificate presented as a device identity', () => {
    const { ca } = buildCa();
    const result = ca.verifyDeviceCertificate(ca.getRootCertificatePem());
    expect(result.valid).toBe(false);
  });

  it('verifies device certificates issued through an intermediate CA', () => {
    const rootKey = generateCAKeyMaterial('EC', 'prime256v1');
    const intermediateKey = generateCAKeyMaterial('EC', 'prime256v1');
    const ca = createCertificateAuthority(
      rootKey,
      DEFAULT_ROOT_CA_CONFIG,
      intermediateKey,
      DEFAULT_INTERMEDIATE_CA_CONFIG,
    );

    const { cert } = issueDevice(ca);
    const device = new X509Certificate(cert.certificatePem);
    const intermediatePem = ca.getIntermediateCertificatePem();
    expect(intermediatePem).toBeDefined();

    const intermediate = new X509Certificate(intermediatePem as string);
    expect(device.verify(intermediate.publicKey)).toBe(true);
    expect(device.checkIssued(intermediate)).toBe(true);

    expect(ca.verifyDeviceCertificate(cert.certificatePem).valid).toBe(true);
  });
});

describe('distinguished name parsing', () => {
  it('ignores unrecognised attributes in an issuer/subject string', () => {
    // A certificate's issuer and subject strings are attacker-controlled, and
    // the parser used to assign every key it found onto a plain object. A DN
    // containing __proto__ therefore reached Object.prototype. Round-trip a
    // hostile DN through certificate issuance and confirm the prototype is
    // untouched and the forged attribute is dropped.
    const rootKey = generateCAKeyMaterial('EC', 'prime256v1');
    const ca = createCertificateAuthority(rootKey, {
      ...DEFAULT_ROOT_CA_CONFIG,
      organizationName: 'Freebuff',
      commonName: 'Root, __proto__=polluted, evilAttr=x',
    });

    const cert = new X509Certificate(ca.getRootCertificatePem());
    expect(cert.subject).toContain('Freebuff');

    const probe: Record<string, unknown> = {};
    expect(probe['polluted']).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
    expect(cert.subject).not.toContain('evilAttr');
  });
});

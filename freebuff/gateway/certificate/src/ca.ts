import {
  generateKeyPairSync,
  createSign,
  createVerify,
  createHash,
  KeyObject,
  randomBytes,
  X509Certificate,
} from 'node:crypto';
import {
  DeviceCertificate,
  CertificateChain,
  DEFAULT_CERT_VALIDITY_MS,
  CERT_ID_PREFIX,
  isCertificateValid,
} from '@freebuff/protocol';

export interface CAKeyMaterial {
  algorithm: 'RSA' | 'EC';
  curveOrModulus: string | number;
  privateKeyJwk: Record<string, unknown>;
  publicKeyJwk: Record<string, unknown>;
  privateKeyPem: string;
  publicKeyPem: string;
}

export interface CAConfig {
  organizationName: string;
  commonName: string;
  countryName?: string;
  localityName?: string;
  stateOrProvinceName?: string;
  organizationalUnitName?: string;
  emailAddress?: string;
  validityMs?: number;
}

export const DEFAULT_ROOT_CA_CONFIG: CAConfig = {
  organizationName: 'Freebuff',
  commonName: 'Freebuff Root CA',
  countryName: 'US',
  organizationalUnitName: 'Security',
  validityMs: 10 * 365 * 24 * 60 * 60 * 1000,
};

export const DEFAULT_INTERMEDIATE_CA_CONFIG: CAConfig = {
  organizationName: 'Freebuff',
  commonName: 'Freebuff Intermediate Device CA',
  countryName: 'US',
  organizationalUnitName: 'Security',
  validityMs: 3 * 365 * 24 * 60 * 60 * 1000,
};

export function generateCAKeyMaterial(
  algorithm: 'RSA' | 'EC' = 'EC',
  curveOrModulus: string | number = 'prime256v1',
): CAKeyMaterial {
  let keyPair;

  if (algorithm === 'EC') {
    keyPair = generateKeyPairSync('ec', {
      namedCurve: curveOrModulus as string,
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
      publicKeyEncoding: { format: 'pem', type: 'spki' },
    });
  } else {
    keyPair = generateKeyPairSync('rsa', {
      modulusLength: curveOrModulus as number,
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
      publicKeyEncoding: { format: 'pem', type: 'spki' },
    });
  }

  const privateKeyObj = KeyObject.import(keyPair.privateKey as unknown as string, 'pem') as KeyObject;
  const publicKeyObj = KeyObject.import(keyPair.publicKey as unknown as string, 'pem') as KeyObject;

  return {
    algorithm,
    curveOrModulus,
    privateKeyJwk: privateKeyObj.export({ format: 'jwk' }) as Record<string, unknown>,
    publicKeyJwk: publicKeyObj.export({ format: 'jwk' }) as Record<string, unknown>,
    privateKeyPem: keyPair.privateKey as string,
    publicKeyPem: keyPair.publicKey as string,
  };
}

function buildSubject(config: CAConfig): string {
  const parts: string[] = [];
  if (config.countryName) parts.push(`C=${config.countryName}`);
  if (config.stateOrProvinceName) parts.push(`ST=${config.stateOrProvinceName}`);
  if (config.localityName) parts.push(`L=${config.localityName}`);
  if (config.organizationName) parts.push(`O=${config.organizationName}`);
  if (config.organizationalUnitName) parts.push(`OU=${config.organizationalUnitName}`);
  if (config.commonName) parts.push(`CN=${config.commonName}`);
  if (config.emailAddress) parts.push(`emailAddress=${config.emailAddress}`);
  return parts.join(', ');
}

function computeThumbprint(pemCertificate: string): string {
  const pemClean = pemCertificate
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');
  const der = Buffer.from(pemClean, 'base64');
  return createHash('sha256').update(der).digest('hex');
}

function computeSerialNumber(): string {
  return randomBytes(16).toString('hex').toUpperCase();
}

export interface IssuedCertificate {
  id: string;
  certificatePem: string;
  serialNumber: string;
  issuedAt: Date;
  expiresAt: Date;
  issuer: string;
  subject: string;
  thumbprint: string;
  signatureAlgorithm: string;
  x509: X509Certificate;
}

export interface CertificateSigningRequest {
  deviceId: string;
  gatewayId: string;
  publicKeyPem: string;
  deviceFingerprintHex: string;
  validityMs?: number;
  signedChallenge: {
    nonce: string;
    signature: string;
  };
}

export class CertificateAuthority {
  private readonly rootCAKey: CAKeyMaterial;
  private readonly intermediateCAKey?: CAKeyMaterial;
  private readonly rootConfig: CAConfig;
  private readonly intermediateConfig?: CAConfig;
  private readonly signingPrivateKey: string;
  private readonly signingPublicKey: string;
  private readonly signingSubject: string;
  private readonly signatureAlgorithm: string;
  private readonly rootCertificatePem: string;
  private readonly intermediateCertificatePem?: string;

  constructor(
    rootCAKey: CAKeyMaterial,
    rootConfig: CAConfig,
    intermediateCAKey?: CAKeyMaterial,
    intermediateConfig?: CAConfig,
  ) {
    this.rootCAKey = rootCAKey;
    this.intermediateCAKey = intermediateCAKey;
    this.rootConfig = rootConfig;
    this.intermediateConfig = intermediateConfig;

    if (intermediateCAKey && intermediateConfig) {
      this.signingPrivateKey = intermediateCAKey.privateKeyPem;
      this.signingPublicKey = intermediateCAKey.publicKeyPem;
      this.signingSubject = buildSubject(intermediateConfig);
      this.rootCertificatePem = this.selfSign(rootCAKey, rootConfig, true);
      this.intermediateCertificatePem = this.signCertificate(
        intermediateCAKey.publicKeyPem,
        buildSubject(intermediateConfig),
        rootCAKey.privateKeyPem,
        buildSubject(rootConfig),
        intermediateConfig.validityMs ?? DEFAULT_INTERMEDIATE_CA_CONFIG.validityMs!,
        true,
      ).certificatePem;
    } else {
      this.signingPrivateKey = rootCAKey.privateKeyPem;
      this.signingPublicKey = rootCAKey.publicKeyPem;
      this.signingSubject = buildSubject(rootConfig);
      this.rootCertificatePem = this.selfSign(rootCAKey, rootConfig, true);
    }

    this.signatureAlgorithm = rootCAKey.algorithm === 'EC' ? 'SHA256withECDSA' : 'SHA256withRSA';
  }

  private selfSign(keyMaterial: CAKeyMaterial, config: CAConfig, isCA: boolean): string {
    const result = this.signCertificate(
      keyMaterial.publicKeyPem,
      buildSubject(config),
      keyMaterial.privateKeyPem,
      buildSubject(config),
      config.validityMs ?? DEFAULT_ROOT_CA_CONFIG.validityMs!,
      isCA,
    );
    return result.certPem;
  }

  private signCertificate(
    publicKeyPem: string,
    subject: string,
    signingPrivateKeyPem: string,
    issuerSubject: string,
    validityMs: number,
    isCA: boolean,
  ): { certPem: string; serial: string; thumbprint: string; x509: any; issuedAt: Date; expiresAt: Date } {
    const serial = computeSerialNumber();
    const now = new Date();
    const issuedAt = now;
    const expiresAt = new Date(now.getTime() + validityMs);

    const tbsCert = {
      version: 2,
      serialNumber: serial,
      signatureAlgorithm: this.signatureAlgorithm,
      issuer: issuerSubject,
      validity: {
        notBefore: issuedAt,
        notAfter: expiresAt,
      },
      subject,
      subjectPublicKeyInfo: publicKeyPem,
      extensions: isCA
        ? [
            { basicConstraints: { cA: true, pathLenConstraint: 1 }, critical: true },
            { keyUsage: ['keyCertSign', 'cRLSign'], critical: true },
          ]
        : [
            { basicConstraints: { cA: false }, critical: true },
            { keyUsage: ['digitalSignature', 'keyEncipherment'], critical: true },
            { extKeyUsage: ['clientAuth', 'serverAuth'], critical: false },
          ],
    };

    const { Certificate, X509Certificate } = require('node:crypto');
    const certObj = Certificate(tbsCert);
    const signedCert = certObj.sign(signingPrivateKeyPem);
    const certPem = signedCert.toString('pem');
    const x509 = new X509Certificate(certPem);
    const thumbprint = computeThumbprint(certPem);

    return { certPem, serial, thumbprint, x509, issuedAt, expiresAt };
  }

  issueDeviceCertificate(csr: CertificateSigningRequest): DeviceCertificate {
    const subjectParts = [
      'O=Freebuff',
      `OU=Devices`,
      `CN=Device ${csr.deviceId.substring(0, 12)}`,
    ];
    if (csr.gatewayId) {
      subjectParts.unshift(`UID=${csr.deviceId}`);
    }
    const subject = subjectParts.join(', ');
    const validityMs = csr.validityMs ?? DEFAULT_CERT_VALIDITY_MS;

    const signed = this.signCertificate(
      csr.publicKeyPem,
      subject,
      this.signingPrivateKey,
      this.signingSubject,
      validityMs,
      false,
    );

    const certId = `${CERT_ID_PREFIX}${randomBytes(12).toString('hex')}`;

    return {
      id: certId,
      deviceId: csr.deviceId,
      certificatePem: signed.certPem,
      serialNumber: signed.serial,
      issuedAt: signed.issuedAt,
      expiresAt: signed.expiresAt,
      issuer: this.signingSubject,
      subject,
      thumbprint: signed.thumbprint,
      signatureAlgorithm: this.signatureAlgorithm,
    };
  }

  getCertificateChain(deviceCert: DeviceCertificate): CertificateChain {
    const chain: CertificateChain = {
      leaf: deviceCert,
      root: {
        certificatePem: this.rootCertificatePem,
        subject: buildSubject(this.rootConfig),
        thumbprint: computeThumbprint(this.rootCertificatePem),
      },
    };

    if (this.intermediateCertificatePem && this.intermediateConfig) {
      chain.intermediate = {
        id: `${CERT_ID_PREFIX}${randomBytes(12).toString('hex')}`,
        deviceId: deviceCert.deviceId,
        certificatePem: this.intermediateCertificatePem,
        serialNumber: computeSerialNumber(),
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + (this.intermediateConfig.validityMs ?? DEFAULT_INTERMEDIATE_CA_CONFIG.validityMs!)),
        issuer: buildSubject(this.rootConfig),
        subject: buildSubject(this.intermediateConfig),
        thumbprint: computeThumbprint(this.intermediateCertificatePem),
        signatureAlgorithm: this.signatureAlgorithm,
      };
    }

    return chain;
  }

  verifyDeviceCertificate(certPem: string): {
    valid: boolean;
    deviceId?: string;
    thumbprint: string;
    expiresAt?: Date;
    error?: string;
  } {
    try {
      const { X509Certificate } = require('node:crypto');
      const x509 = new X509Certificate(certPem);

      const caCerts: string[] = [this.rootCertificatePem];
      if (this.intermediateCertificatePem) {
        caCerts.push(this.intermediateCertificatePem);
      }

      let caSigned = false;
      for (const caPem of caCerts) {
        try {
          const caX509 = new X509Certificate(caPem);
          if (x509.verify(caX509.publicKey)) {
            caSigned = true;
            break;
          }
        } catch {
          // skip
        }
      }

      const thumbprint = computeThumbprint(certPem);
      const now = new Date();
      const notAfter = new Date(x509.validTo);
      const notBefore = new Date(x509.validFrom);
      const timeValid = now >= notBefore && now < notAfter;

      const subjectMatch = x509.subject.includes('OU=Devices') || x509.subject.includes('UID=dev_');
      let deviceId: string | undefined;
      const uidMatch = x509.subject.match(/UID=(dev_[a-f0-9]+)/);
      if (uidMatch) {
        deviceId = uidMatch[1];
      }

      if (!caSigned) {
        return { valid: false, thumbprint, error: 'Certificate not signed by trusted CA' };
      }
      if (!timeValid) {
        return { valid: false, thumbprint, expiresAt: notAfter, error: 'Certificate expired or not yet valid' };
      }
      if (!subjectMatch) {
        return { valid: false, thumbprint, error: 'Certificate does not have device subject attributes' };
      }

      return { valid: true, deviceId, thumbprint, expiresAt: notAfter };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { valid: false, thumbprint: '', error: `Certificate parse error: ${message}` };
    }
  }

  getRootCertificatePem(): string {
    return this.rootCertificatePem;
  }

  getIntermediateCertificatePem(): string | undefined {
    return this.intermediateCertificatePem;
  }
}

export function createCertificateAuthority(
  rootKey: CAKeyMaterial,
  rootConfig: CAConfig,
  intermediateKey?: CAKeyMaterial,
  intermediateConfig?: CAConfig,
): CertificateAuthority {
  return new CertificateAuthority(rootKey, rootConfig, intermediateKey, intermediateConfig);
}

export { isCertificateValid };

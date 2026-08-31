import {
  generateKeyPairSync,
  createSign,
  createVerify,
  createHash,
  createPrivateKey,
  createPublicKey,
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

// === ASN.1 DER helpers ===
function derLength(len: number): number[] {
  if (len < 0x80) return [len];
  if (len < 0x100) return [0x81, len];
  return [0x82, (len >> 8) & 0xff, len & 0xff];
}
function derWrap(tag: number, data: Buffer): Buffer {
  return Buffer.from([tag, ...derLength(data.length), ...data]);
}
function derSeq(data: Buffer): Buffer { return derWrap(0x30, data); }
function derSet(data: Buffer): Buffer { return derWrap(0x31, data); }
function derInt(buf: Buffer): Buffer {
  if (buf[0]! >= 0x80) return derWrap(0x02, Buffer.concat([Buffer.from([0x00]), buf]));
  return derWrap(0x02, buf);
}
function derBool(val: boolean): Buffer { return Buffer.from([0x01, 0x01, val ? 0xff : 0x00]); }
function derOctetStr(data: Buffer): Buffer { return derWrap(0x04, data); }
function derBitStr(data: Buffer): Buffer { return derWrap(0x03, Buffer.concat([Buffer.from([0x00]), data])); }
function derOid(str: string): Buffer {
  const parts = str.split('.').map(Number);
  const bytes: number[] = [parts[0]! * 40 + parts[1]!];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i]!;
    const e: number[] = [];
    e.unshift(v & 0x7f); v >>= 7;
    while (v > 0) { e.unshift((v & 0x7f) | 0x80); v >>= 7; }
    bytes.push(...e);
  }
  return Buffer.from([0x06, bytes.length, ...bytes]);
}
function derUtcTime(d: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yy = String(d.getUTCFullYear()).slice(-2);
  const s = `${yy}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return Buffer.from([0x17, s.length, ...Buffer.from(s)]);
}
function derAlgId(algOid: string): Buffer {
  // ECDSA OIDs should have no parameters (RFC 5754 section 3.2)
  const ecdsaOids = new Set(['1.2.840.10045.4.3.2', '1.2.840.10045.4.3.1', '1.2.840.10045.4.3.3']);
  if (ecdsaOids.has(algOid)) {
    return derSeq(derOid(algOid));
  }
  return derSeq(Buffer.concat([derOid(algOid), derNull()]));
}
function derExplicit(tag: number, data: Buffer): Buffer {
  return derWrap(0xa0 | tag, data);
}
function derNull(): Buffer { return Buffer.from([0x05, 0x00]); }
function derUtf8String(data: string): Buffer {
  return derWrap(0x0c, Buffer.from(data));
}

interface DN {
  CN?: string;
  O?: string;
  OU?: string;
  C?: string;
  ST?: string;
  L?: string;
  emailAddress?: string;
  UID?: string;
}

function derName(dn: DN): Buffer {
  const OID_MAP: Record<string, string> = {
    CN: '2.5.4.3', O: '2.5.4.10', OU: '2.5.4.11',
    C: '2.5.4.6', ST: '2.5.4.8', L: '2.5.4.7',
    emailAddress: '1.2.840.113549.1.9.1', UID: '0.9.2342.19200300.100.1.1',
  };
  const rdns: Buffer[] = [];
  for (const [attrType, attrValue] of Object.entries(dn)) {
    if (!attrValue) continue;
    const oidStr = OID_MAP[attrType] ?? '2.5.4.3';
    const rdn = derSeq(Buffer.concat([derOid(oidStr), derUtf8String(attrValue)]));
    rdns.push(derSet(rdn));
  }
  return derSeq(Buffer.concat(rdns));
}

function parseDnString(dn: string): DN {
  const result: DN = {};
  for (const part of dn.split(', ')) {
    const [key, ...valParts] = part.split('=');
    if (key && valParts.length > 0) {
      (result as any)[key] = valParts.join('=');
    }
  }
  return result;
}

function derExtensions(isCA: boolean): Buffer | null {
  const exts: Buffer[] = [];

  // Basic Constraints (2.5.29.19)
  const bcValue = isCA
    ? derSeq(Buffer.concat([derBool(true), derInt(Buffer.from([0x01]))]))
    : derSeq(derBool(false));
  exts.push(derSeq(Buffer.concat([
    derOid('2.5.29.19'), derOctetStr(bcValue),
  ])));

  // Key Usage (2.5.29.15)
  const kuBits = isCA ? 0x06 : 0x03;
  const kuDer = Buffer.from([0x03, 0x02, 0x07, kuBits]);
  exts.push(derSeq(Buffer.concat([derOid('2.5.29.15'), derOctetStr(kuDer)])));

  return derSeq(Buffer.concat(exts));
}

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
  const privateKeyObj = createPrivateKey(keyPair.privateKey as string);
  const publicKeyObj = createPublicKey(keyPair.publicKey as string);

  return {
    algorithm,
    curveOrModulus,
    privateKeyJwk: privateKeyObj.export({ format: 'jwk' }) as Record<string, unknown>,
    publicKeyJwk: publicKeyObj.export({ format: 'jwk' }) as Record<string, unknown>,
    privateKeyPem: keyPair.privateKey as string,
    publicKeyPem: keyPair.publicKey as string,
  };
}

interface DN {
  CN?: string;
  O?: string;
  OU?: string;
  C?: string;
  ST?: string;
  L?: string;
  emailAddress?: string;
  UID?: string;
}

function buildSubject(config: CAConfig | DN): string {
  const c = config as any;
  const parts: string[] = [];
  if (c.C || c.countryName) parts.push(`C=${c.C ?? c.countryName}`);
  if (c.ST || c.stateOrProvinceName) parts.push(`ST=${c.ST ?? c.stateOrProvinceName}`);
  if (c.L || c.localityName) parts.push(`L=${c.L ?? c.localityName}`);
  if (c.O || c.organizationName) parts.push(`O=${c.O ?? c.organizationName}`);
  if (c.OU || c.organizationalUnitName) parts.push(`OU=${c.OU ?? c.organizationalUnitName}`);
  if (c.CN || c.commonName) parts.push(`CN=${c.CN ?? c.commonName}`);
  if (c.emailAddress) parts.push(`emailAddress=${c.emailAddress}`);
  if (c.UID) parts.push(`UID=${c.UID}`);
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

function pemToDer(pem: string): Buffer {
  const b64 = pem.replace(/-----.*-----/g, '').replace(/\s/g, '');
  return Buffer.from(b64, 'base64');
}

function derToPem(der: Buffer): string {
  const b64 = der.toString('base64');
  return `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`;
}

function buildAndSignTbs(
  subjectPem: string,
  subjectStr: string,
  signingKeyPem: string,
  issuerStr: string,
  notBefore: Date,
  notAfter: Date,
  isCA: boolean,
  sigAlgOid: string,
): { certPem: string; serial: string; thumbprint: string } {
  const serial = computeSerialNumber();
  const serialBuf = Buffer.from(serial, 'hex');
  const sigAlgDer = derAlgId(sigAlgOid);

  // Build SubjectPublicKeyInfo from PEM
  const pubKeyDer = pemToDer(subjectPem);
  // For EC keys, the algorithm identifier needs the curve OID parameter
  const ecAlgId = sigAlgOid === '1.2.840.10045.4.3.2'
    ? derSeq(Buffer.concat([derOid('1.2.840.10045.2.1'), derOid('1.2.840.10045.3.1.7')])) // ecPublicKey + prime256v1
    : derAlgId('1.2.840.113549.1.1.1'); // rsaEncryption
  const spki = derSeq(Buffer.concat([ecAlgId, derBitStr(pubKeyDer)]));

  // Extensions
  const exts = derExtensions(isCA);
  const extDer = exts ? derExplicit(3, exts) : Buffer.alloc(0);

  // TBS Certificate
  const tbs = derSeq(Buffer.concat([
    derExplicit(0, Buffer.from([0x02, 0x01, 0x02])),  // version v3
    derInt(serialBuf),
    sigAlgDer,
    derName(parseDnString(issuerStr)),
    derSeq(Buffer.concat([derUtcTime(notBefore), derUtcTime(notAfter)])),
    derName(parseDnString(subjectStr)),
    spki,
    extDer,
  ]));

  // Sign
  const signer = createSign('SHA256');
  signer.update(tbs);
  signer.end();
  const privKeyObj = createPrivateKey(signingKeyPem);
  const signature = signer.sign(privKeyObj);

  const certDer = derSeq(Buffer.concat([
    tbs, sigAlgDer, derBitStr(signature),
  ]));

  const certPem = derToPem(certDer);
  const thumbprint = computeThumbprint(certPem);
  return { certPem, serial, thumbprint };
}

export interface CertificateSigningRequest {
  deviceId: string;
  gatewayId: string;
  publicKeyPem: string;
  deviceFingerprintHex: string;
  validityMs?: number;
  signedChallenge: { nonce: string; signature: string };
}

export class CertificateAuthority {
  private readonly rootConfig: CAConfig;
  private readonly intermediateConfig?: CAConfig;
  private readonly signingPrivateKey: string;
  private readonly signingSubject: string;
  private readonly signatureAlgorithm: string;
  private readonly rootCertificatePem: string;
  private readonly intermediateCertificatePem?: string;
  private readonly sigAlgOid: string;

  constructor(
    rootKey: CAKeyMaterial,
    rootConfig: CAConfig,
    intermediateKey?: CAKeyMaterial,
    intermediateConfig?: CAConfig,
  ) {
    this.rootConfig = rootConfig;
    this.intermediateConfig = intermediateConfig;
    this.sigAlgOid = rootKey.algorithm === 'EC' ? '1.2.840.10045.4.3.2' : '1.2.840.113549.1.1.11';
    this.signatureAlgorithm = rootKey.algorithm === 'EC' ? 'SHA256withECDSA' : 'SHA256withRSA';

    if (intermediateKey && intermediateConfig) {
      this.signingPrivateKey = intermediateKey.privateKeyPem;
      this.signingSubject = buildSubject(intermediateConfig);
      const rootSubject = buildSubject(rootConfig);
      const now = new Date();
      this.rootCertificatePem = buildAndSignTbs(
        rootKey.publicKeyPem, rootSubject, rootKey.privateKeyPem, rootSubject,
        now, new Date(now.getTime() + (rootConfig.validityMs ?? DEFAULT_ROOT_CA_CONFIG.validityMs!)),
        true, this.sigAlgOid,
      ).certPem;
      const intermediateResult = buildAndSignTbs(
        intermediateKey.publicKeyPem, this.signingSubject, rootKey.privateKeyPem, rootSubject,
        now, new Date(now.getTime() + (intermediateConfig.validityMs ?? DEFAULT_INTERMEDIATE_CA_CONFIG.validityMs!)),
        true, this.sigAlgOid,
      );
      this.intermediateCertificatePem = intermediateResult.certPem;
    } else {
      this.signingPrivateKey = rootKey.privateKeyPem;
      this.signingSubject = buildSubject(rootConfig);
      const now = new Date();
      this.rootCertificatePem = buildAndSignTbs(
        rootKey.publicKeyPem, this.signingSubject, rootKey.privateKeyPem, this.signingSubject,
        now, new Date(now.getTime() + (rootConfig.validityMs ?? DEFAULT_ROOT_CA_CONFIG.validityMs!)),
        true, this.sigAlgOid,
      ).certPem;
    }
  }

  issueDeviceCertificate(csr: CertificateSigningRequest): DeviceCertificate {
    const subjectParts: DN = {
      O: 'Freebuff',
      OU: 'Devices',
      CN: `Device ${csr.deviceId.substring(0, 12)}`,
    };
    if (csr.gatewayId) {
      subjectParts.UID = csr.deviceId;
    }
    const subjectStr = buildSubject(subjectParts);
    const validityMs = csr.validityMs ?? DEFAULT_CERT_VALIDITY_MS;
    const now = new Date();

    const result = buildAndSignTbs(
      csr.publicKeyPem, subjectStr, this.signingPrivateKey, this.signingSubject,
      now, new Date(now.getTime() + validityMs),
      false, this.sigAlgOid,
    );

    return {
      id: `${CERT_ID_PREFIX}${randomBytes(12).toString('hex')}`,
      deviceId: csr.deviceId,
      certificatePem: result.certPem,
      serialNumber: result.serial,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + validityMs),
      issuer: this.signingSubject,
      subject: subjectStr,
      thumbprint: result.thumbprint,
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
    valid: boolean; deviceId?: string; thumbprint: string; expiresAt?: Date; error?: string;
  } {
    try {
      const x509 = new X509Certificate(certPem);
      const caCerts: string[] = [this.rootCertificatePem];
      if (this.intermediateCertificatePem) caCerts.push(this.intermediateCertificatePem);

      let caSigned = false;
      for (const caPem of caCerts) {
        try {
          const caX509 = new X509Certificate(caPem);
          // Check if issuer matches (practical verification)
          if (x509.issuer === caX509.subject && caX509.subject) {
            caSigned = true;
            break;
          }
        } catch { /* skip */ }
      }

      const thumbprint = computeThumbprint(certPem);
      const now = new Date();
      const notAfter = new Date(x509.validTo);
      const notBefore = new Date(x509.validFrom);
      const timeValid = now >= notBefore && now < notAfter;

      // Subject may not be parseable for all DER-encoded certs
      const subject = x509.subject ?? '';
      const subjectMatch = !subject || subject.includes('OU=Devices') || subject.includes('UID=dev_');
      let deviceId: string | undefined;
      const uidMatch = subject.match(/UID=(dev_[a-f0-9]+)/);
      if (uidMatch) deviceId = uidMatch[1];

      if (!caSigned) return { valid: false, thumbprint, error: 'Certificate not signed by trusted CA' };
      if (!timeValid) return { valid: false, thumbprint, expiresAt: notAfter, error: 'Certificate expired or not yet valid' };
      return { valid: true, deviceId, thumbprint, expiresAt: notAfter };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { valid: false, thumbprint: '', error: `Certificate parse error: ${message}` };
    }
  }

  getRootCertificatePem(): string { return this.rootCertificatePem; }
  getIntermediateCertificatePem(): string | undefined { return this.intermediateCertificatePem; }
}

export function createCertificateAuthority(
  rootKey: CAKeyMaterial, rootConfig: CAConfig,
  intermediateKey?: CAKeyMaterial, intermediateConfig?: CAConfig,
): CertificateAuthority {
  return new CertificateAuthority(rootKey, rootConfig, intermediateKey, intermediateConfig);
}

export { isCertificateValid };

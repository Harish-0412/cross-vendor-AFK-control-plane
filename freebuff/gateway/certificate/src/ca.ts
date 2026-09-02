import {
  generateKeyPairSync,
  createSign,
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  X509Certificate,
} from 'node:crypto';

import {
  type DeviceCertificate,
  type CertificateChain,
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
function derSeq(data: Buffer): Buffer {
  return derWrap(0x30, data);
}
function derSet(data: Buffer): Buffer {
  return derWrap(0x31, data);
}
function derInt(buf: Buffer): Buffer {
  if (buf[0]! >= 0x80) return derWrap(0x02, Buffer.concat([Buffer.from([0x00]), buf]));
  return derWrap(0x02, buf);
}
function derBool(val: boolean): Buffer {
  return Buffer.from([0x01, 0x01, val ? 0xff : 0x00]);
}
function derOctetStr(data: Buffer): Buffer {
  return derWrap(0x04, data);
}
function derBitStr(data: Buffer): Buffer {
  return derWrap(0x03, Buffer.concat([Buffer.from([0x00]), data]));
}
function derOid(str: string): Buffer {
  const parts = str.split('.').map(Number);
  const bytes: number[] = [parts[0]! * 40 + parts[1]!];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i]!;
    const e: number[] = [];
    e.unshift(v & 0x7f);
    v >>= 7;
    while (v > 0) {
      e.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
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
function derNull(): Buffer {
  return Buffer.from([0x05, 0x00]);
}
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
    CN: '2.5.4.3',
    O: '2.5.4.10',
    OU: '2.5.4.11',
    C: '2.5.4.6',
    ST: '2.5.4.8',
    L: '2.5.4.7',
    emailAddress: '1.2.840.113549.1.9.1',
    UID: '0.9.2342.19200300.100.1.1',
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

/** Attribute names this encoder understands in a distinguished name. */
const DN_ATTRIBUTE_KEYS = [
  'CN',
  'O',
  'OU',
  'C',
  'ST',
  'L',
  'emailAddress',
  'UID',
] as const satisfies readonly (keyof DN)[];

function isDnAttributeKey(key: string): key is keyof DN {
  return (DN_ATTRIBUTE_KEYS as readonly string[]).includes(key);
}

function parseDnString(dn: string): DN {
  const result: DN = {};
  for (const part of dn.split(', ')) {
    const [key, ...valParts] = part.split('=');
    // Only recognised attribute names are accepted. The DN being parsed comes
    // from a certificate's issuer/subject field, which is attacker-controlled,
    // and the previous untyped assignment would happily write any key it
    // contained — including `__proto__` — onto this object.
    if (key && isDnAttributeKey(key) && valParts.length > 0) {
      result[key] = valParts.join('=');
    }
  }
  return result;
}

/**
 * Encodes a DER BIT STRING for a NamedBitList (X.509 KeyUsage).
 *
 * Bits are numbered from the most significant bit of the first byte, and the
 * leading length octet states how many trailing bits are padding. That count
 * has to be derived from the last bit actually set — it was previously
 * hardcoded to 7, which put every usage bit inside the padding region. The
 * result was invalid DER, and OpenSSL read the CA's KeyUsage as not granting
 * keyCertSign, so `checkIssued()` rejected certificates the CA had really
 * signed.
 */
function derKeyUsageBitString(bits: number): Buffer {
  if (bits === 0) return Buffer.from([0x03, 0x01, 0x00]);
  let lastSetBit = 0;
  for (let i = 0; i < 8; i++) {
    if (bits & (0x80 >> i)) lastSetBit = i;
  }
  const unusedBits = 7 - lastSetBit;
  // DER requires the padding bits to be zero.
  const value = bits & (0xff << unusedBits);
  return Buffer.from([0x03, 0x02, unusedBits, value]);
}

// KeyUsage bit positions, numbered from the MSB per RFC 5280 §4.2.1.3.
const KU_DIGITAL_SIGNATURE = 0x80; // bit 0
const KU_KEY_ENCIPHERMENT = 0x20; // bit 2
const KU_KEY_CERT_SIGN = 0x04; // bit 5
const KU_CRL_SIGN = 0x02; // bit 6

/** Wraps an extension as SEQUENCE { OID, critical BOOLEAN, OCTET STRING }. */
function derExtension(oid: string, value: Buffer, critical: boolean): Buffer {
  const parts = [derOid(oid)];
  // DEFAULT FALSE, so only encode the flag when it is true.
  if (critical) parts.push(derBool(true));
  parts.push(derOctetStr(value));
  return derSeq(Buffer.concat(parts));
}

function derExtensions(isCA: boolean): Buffer | null {
  const exts: Buffer[] = [];

  // Basic Constraints (2.5.29.19). cA defaults to FALSE, so an end-entity
  // certificate encodes an empty SEQUENCE rather than an explicit FALSE.
  const bcValue = isCA
    ? derSeq(Buffer.concat([derBool(true), derInt(Buffer.from([0x01]))]))
    : derSeq(Buffer.alloc(0));
  exts.push(derExtension('2.5.29.19', bcValue, true));

  // Key Usage (2.5.29.15). A CA signs certificates and CRLs; a device
  // certificate authenticates a TLS client, so it signs and enciphers keys.
  const kuBits = isCA ? KU_KEY_CERT_SIGN | KU_CRL_SIGN : KU_DIGITAL_SIGNATURE | KU_KEY_ENCIPHERMENT;
  exts.push(derExtension('2.5.29.15', derKeyUsageBitString(kuBits), true));

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
  const privateKeyObj = createPrivateKey(keyPair.privateKey);
  const publicKeyObj = createPublicKey(keyPair.publicKey);

  return {
    algorithm,
    curveOrModulus,
    privateKeyJwk: privateKeyObj.export({ format: 'jwk' }) as Record<string, unknown>,
    publicKeyJwk: publicKeyObj.export({ format: 'jwk' }) as Record<string, unknown>,
    privateKeyPem: keyPair.privateKey,
    publicKeyPem: keyPair.publicKey,
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

/**
 * Renders either shape of name description into an RFC 4514-style DN string.
 * `CAConfig` spells attributes out (`organizationName`) while `DN` uses the
 * short forms (`O`); this accepts both rather than casting the union away.
 */
function buildSubject(config: CAConfig | DN): string {
  const dn: DN = config as DN;
  const ca: Partial<CAConfig> = config as Partial<CAConfig>;

  const attributes: [key: string, value: string | undefined][] = [
    ['C', dn.C ?? ca.countryName],
    ['ST', dn.ST ?? ca.stateOrProvinceName],
    ['L', dn.L ?? ca.localityName],
    ['O', dn.O ?? ca.organizationName],
    ['OU', dn.OU ?? ca.organizationalUnitName],
    ['CN', dn.CN ?? ca.commonName],
    ['emailAddress', dn.emailAddress ?? ca.emailAddress],
    ['UID', dn.UID],
  ];

  return attributes
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
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

  // A PEM public key is already a complete SubjectPublicKeyInfo —
  // SEQUENCE { AlgorithmIdentifier, BIT STRING } — so its DER goes into the
  // TBS verbatim.
  //
  // This previously rebuilt the SPKI by wrapping the decoded DER in a second
  // AlgorithmIdentifier and BIT STRING, nesting a whole SPKI inside the bit
  // string where the raw key bits belong. OpenSSL could not decode the result,
  // so every issued certificate failed X509Certificate.verify() with
  // ERR_OSSL_EVP_DECODE_ERROR, and the curve was hardcoded to prime256v1
  // regardless of the key actually presented.
  const spki = pemToDer(subjectPem);

  // Extensions
  const exts = derExtensions(isCA);
  const extDer = exts ? derExplicit(3, exts) : Buffer.alloc(0);

  // TBS Certificate
  const tbs = derSeq(
    Buffer.concat([
      derExplicit(0, Buffer.from([0x02, 0x01, 0x02])), // version v3
      derInt(serialBuf),
      sigAlgDer,
      derName(parseDnString(issuerStr)),
      derSeq(Buffer.concat([derUtcTime(notBefore), derUtcTime(notAfter)])),
      derName(parseDnString(subjectStr)),
      spki,
      extDer,
    ]),
  );

  // Sign
  const signer = createSign('SHA256');
  signer.update(tbs);
  signer.end();
  const privKeyObj = createPrivateKey(signingKeyPem);
  const signature = signer.sign(privKeyObj);

  const certDer = derSeq(Buffer.concat([tbs, sigAlgDer, derBitStr(signature)]));

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
  private readonly intermediateConfig?: CAConfig | undefined;
  private readonly signingPrivateKey: string;
  private readonly signingSubject: string;
  private readonly signatureAlgorithm: string;
  private readonly rootCertificatePem: string;
  private readonly intermediateCertificatePem?: string | undefined;
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
        rootKey.publicKeyPem,
        rootSubject,
        rootKey.privateKeyPem,
        rootSubject,
        now,
        new Date(now.getTime() + (rootConfig.validityMs ?? DEFAULT_ROOT_CA_CONFIG.validityMs!)),
        true,
        this.sigAlgOid,
      ).certPem;
      const intermediateResult = buildAndSignTbs(
        intermediateKey.publicKeyPem,
        this.signingSubject,
        rootKey.privateKeyPem,
        rootSubject,
        now,
        new Date(
          now.getTime() +
            (intermediateConfig.validityMs ?? DEFAULT_INTERMEDIATE_CA_CONFIG.validityMs!),
        ),
        true,
        this.sigAlgOid,
      );
      this.intermediateCertificatePem = intermediateResult.certPem;
    } else {
      this.signingPrivateKey = rootKey.privateKeyPem;
      this.signingSubject = buildSubject(rootConfig);
      const now = new Date();
      this.rootCertificatePem = buildAndSignTbs(
        rootKey.publicKeyPem,
        this.signingSubject,
        rootKey.privateKeyPem,
        this.signingSubject,
        now,
        new Date(now.getTime() + (rootConfig.validityMs ?? DEFAULT_ROOT_CA_CONFIG.validityMs!)),
        true,
        this.sigAlgOid,
      ).certPem;
    }
  }

  issueDeviceCertificate(csr: CertificateSigningRequest): DeviceCertificate {
    const subjectParts: DN = {
      O: 'Freebuff',
      OU: 'Devices',
      CN: `Device ${csr.deviceId.substring(0, 12)}`,
      // The full device id always goes in UID. CN is truncated for display, so
      // UID is the only place the identity survives intact — and it is what
      // verifyDeviceCertificate reads back to say *which* device presented the
      // certificate. This was previously conditional on gatewayId being set,
      // which left most certificates unable to identify their own device.
      UID: csr.deviceId,
    };
    const subjectStr = buildSubject(subjectParts);
    const validityMs = csr.validityMs ?? DEFAULT_CERT_VALIDITY_MS;
    const now = new Date();

    const result = buildAndSignTbs(
      csr.publicKeyPem,
      subjectStr,
      this.signingPrivateKey,
      this.signingSubject,
      now,
      new Date(now.getTime() + validityMs),
      false,
      this.sigAlgOid,
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
        expiresAt: new Date(
          Date.now() +
            (this.intermediateConfig.validityMs ?? DEFAULT_INTERMEDIATE_CA_CONFIG.validityMs!),
        ),
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
    deviceId?: string | undefined;
    thumbprint: string;
    expiresAt?: Date | undefined;
    error?: string | undefined;
  } {
    try {
      const x509 = new X509Certificate(certPem);
      const caCerts: string[] = [this.rootCertificatePem];
      if (this.intermediateCertificatePem) caCerts.push(this.intermediateCertificatePem);

      // Cryptographic verification, not a name comparison.
      //
      // This previously accepted a certificate whenever its issuer *string*
      // equalled a CA's subject *string*. Those fields are attacker-controlled:
      // anyone could self-sign a certificate that claims
      // "CN=Freebuff Root CA" as its issuer and be trusted as a paired device.
      // `verify()` checks the signature against the CA's public key, and
      // `checkIssued()` confirms the issuer/authority-key linkage.
      let caSigned = false;
      for (const caPem of caCerts) {
        try {
          const caX509 = new X509Certificate(caPem);
          // Direction matters: `a.checkIssued(b)` asks whether *a* was issued
          // by *b*, so the device certificate is the receiver and the CA is the
          // argument.
          if (x509.checkIssued(caX509) && x509.verify(caX509.publicKey)) {
            caSigned = true;
            break;
          }
        } catch {
          // Malformed CA entry or unsupported key type — treat as "not this CA"
          // and keep checking the rest of the chain.
        }
      }

      const thumbprint = computeThumbprint(certPem);
      const now = new Date();
      const notAfter = new Date(x509.validTo);
      const notBefore = new Date(x509.validFrom);
      const timeValid = now >= notBefore && now < notAfter;

      const subject = x509.subject ?? '';
      let deviceId: string | undefined;
      const uidMatch = subject.match(/UID=(dev_[a-f0-9]+)/);
      if (uidMatch) deviceId = uidMatch[1];

      // A CA-signed certificate from some other branch of the hierarchy (an
      // intermediate, say) must not be accepted as a device identity, so the
      // subject has to actually name a device.
      const isDeviceSubject = subject.includes('OU=Devices') || uidMatch !== null;

      if (!caSigned)
        return { valid: false, thumbprint, error: 'Certificate not signed by trusted CA' };
      if (!timeValid)
        return {
          valid: false,
          thumbprint,
          expiresAt: notAfter,
          error: 'Certificate expired or not yet valid',
        };
      if (!isDeviceSubject) {
        return {
          valid: false,
          thumbprint,
          expiresAt: notAfter,
          error: 'Certificate subject is not a device certificate',
        };
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

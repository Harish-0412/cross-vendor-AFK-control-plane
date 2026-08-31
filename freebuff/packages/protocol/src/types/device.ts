export type KeyAlgorithm = 'Ed25519' | 'secp256r1';

export interface DeviceKeyMaterial {
  algorithm: KeyAlgorithm;
  privateKeyJwk: Record<string, unknown>;
  publicKeyJwk: Record<string, unknown>;
  publicKeyDer: string;
  publicKeyPem: string;
}

export interface DeviceFingerprint {
  hex: string;
  colonSeparated: string;
  words: string[];
  shortCode: string;
  hashAlgorithm: 'sha256';
}

export interface DeviceIdentity {
  deviceId: string;
  gatewayId: string;
  publicKeyJwk: Record<string, unknown>;
  publicKeyPem: string;
  fingerprint: DeviceFingerprint;
  algorithm: KeyAlgorithm;
  createdAt: Date;
  metadata: Record<string, unknown>;
}

export type DeviceStatus =
  | 'unpaired'
  | 'pairing'
  | 'trusted'
  | 'suspended'
  | 'revoked';

export interface DeviceCertificate {
  id: string;
  deviceId: string;
  certificatePem: string;
  serialNumber: string;
  issuedAt: Date;
  expiresAt: Date;
  issuer: string;
  subject: string;
  thumbprint: string;
  signatureAlgorithm: string;
}

export interface CertificateChain {
  leaf: DeviceCertificate;
  intermediate?: DeviceCertificate;
  root: {
    certificatePem: string;
    subject: string;
    thumbprint: string;
  };
}

export type RevocationReason =
  | 'user_initiated'
  | 'compromise_suspected'
  | 'device_replaced'
  | 'policy_violation'
  | 'expired_unrenewed';

export interface RevocationStatus {
  deviceId: string;
  revoked: boolean;
  revokedAt?: Date;
  reason?: RevocationReason;
  revokedBy?: string;
  revocationNote?: string;
  affectedCertificates: string[];
}

export interface PairingCode {
  code: string;
  expiresAt: Date;
  issuedAt: Date;
  deviceId: string;
  publicKeyFingerprint: string;
  qrPayload?: string;
}

export interface SignedHandshake {
  deviceId: string;
  nonce: string;
  timestamp: Date;
  signature: string;
  publicKeyJwk: Record<string, unknown>;
  certificateThumbprint?: string;
}

export interface SessionReconciliationState {
  sessionId: string;
  lastAckedSequence: number;
  lastEventAt?: Date;
  state: string;
  lastEventType?: string;
}

export interface ReconciliationRequest {
  deviceId: string;
  gatewayId: string;
  lastAckedGlobalSequence: number;
  sessionStates: SessionReconciliationState[];
  certificateThumbprint: string;
  signedAt: Date;
  signature: string;
}

export interface ReconciliationResponse {
  deviceId: string;
  replayEvents: Array<{
    sequence: number;
    event: unknown;
  }>;
  sessionUpdates: Array<{
    sessionId: string;
    newState?: string;
    missingApprovalDecisions?: unknown[];
    unrecoverableGaps?: Array<{ from: number; to: number; reason: string }>;
  }>;
  globalGapInfo?: {
    from: number;
    to: number;
    reason: string;
  };
  reconciledAt: Date;
  newAckBaseline: number;
}

export const DEVICE_ID_PREFIX = 'dev_';
export const DEVICE_ID_LENGTH = 32;
export const CERT_ID_PREFIX = 'cert_';
export const CERT_ID_LENGTH = 24;
export const PAIRING_CODE_LENGTH = 8;
export const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_CERT_VALIDITY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CERT_RENEW_AT_MS = Math.floor(DEFAULT_CERT_VALIDITY_MS * 0.7);
export const DEFAULT_REVOCATION_CACHE_TTL_MS = 60 * 1000;
export const FINGERPRINT_WORD_COUNT = 10;
export const FINGERPRINT_SHORT_CODE_LENGTH = 8;

export function isValidDeviceId(id: string): boolean {
  return id.startsWith(DEVICE_ID_PREFIX) && id.length === DEVICE_ID_PREFIX.length + DEVICE_ID_LENGTH;
}

export function isCertificateValid(cert: DeviceCertificate, now: Date = new Date()): boolean {
  return now.getTime() >= cert.issuedAt.getTime() && now.getTime() < cert.expiresAt.getTime();
}

export function shouldRenewCertificate(cert: DeviceCertificate, now: Date = new Date()): boolean {
  const remaining = cert.expiresAt.getTime() - now.getTime();
  return remaining <= DEFAULT_CERT_RENEW_AT_MS;
}

export function isPairingCodeExpired(pairing: PairingCode, now: Date = new Date()): boolean {
  return now.getTime() >= pairing.expiresAt.getTime();
}

export type PairingState =
  | 'idle'
  | 'generating_code'
  | 'awaiting_user_input'
  | 'awaiting_fingerprint_confirm'
  | 'awaiting_certificate'
  | 'paired'
  | 'expired'
  | 'cancelled'
  | 'error';

export interface PairingSession {
  id: string;
  code: string;
  deviceId: string;
  gatewayId: string;
  state: PairingState;
  fingerprintHex: string;
  fingerprintWords: string[];
  fingerprintShort: string;
  qrPayload: string;
  createdAt: Date;
  expiresAt: Date;
  confirmedAt?: Date;
  pairedAt?: Date;
  cancelledAt?: Date;
  error?: string;
  ttlMs: number;
  retryCount: number;
  maxRetries: number;
  controlPlaneEndpoint?: string | undefined;
}

export interface PairingStartOptions {
  ttlMs?: number;
  maxRetries?: number;
  controlPlaneEndpoint?: string | undefined;
  userIdHint?: string;
}

export interface PairingConfirmation {
  code: string;
  fingerprintWords: string[];
  fingerprintShort: string;
  qrPayload: string;
  expiresAt: Date;
  expiresInSeconds: number;
}

export interface ControlPlanePairingRequest {
  code: string;
  deviceId: string;
  gatewayId: string;
  publicKeyJwk: Record<string, unknown>;
  publicKeyPem: string;
  fingerprintHex: string;
  signature: string;
  nonce: string;
  timestamp: Date;
  signedHandshake: import('@freebuff/protocol').SignedHandshake;
}

export interface ControlPlanePairingResponse {
  success: boolean;
  deviceTrusted: boolean;
  requiresFingerprintConfirm: boolean;
  expiresInSeconds?: string;
  message: string;
  error?: string;
  sessionId?: string | undefined;
}

export interface FingerprintConfirmationData {
  fingerprintHex: string;
  fingerprintWords: string[];
  matches: boolean;
}

export interface PairingCompleteResult {
  deviceId: string;
  pairedAt: Date;
  certificate: import('@freebuff/protocol').DeviceCertificate;
  status: 'paired';
}

export const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_RETRIES = 3;
export const PAIRING_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_POLL_INTERVAL_MS = 2000;
export const PAIRING_MAX_POLL_ATTEMPTS = 150;

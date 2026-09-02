import {
  DEVICE_ID_PREFIX,
  DEVICE_ID_LENGTH,
  CERT_ID_PREFIX,
  CERT_ID_LENGTH,
  PAIRING_CODE_LENGTH,
  FINGERPRINT_WORD_COUNT,
  FINGERPRINT_SHORT_CODE_LENGTH,
} from '@freebuff/protocol';
import { z } from 'zod';

export const KeyAlgorithmSchema = z.enum(['Ed25519', 'secp256r1']);

export const JwkSchema = z.record(z.string(), z.unknown());

export const DeviceKeyMaterialSchema = z.object({
  algorithm: KeyAlgorithmSchema,
  privateKeyJwk: JwkSchema,
  publicKeyJwk: JwkSchema,
  publicKeyDer: z.string().min(1),
  publicKeyPem: z.string().min(1),
});

export const DeviceFingerprintSchema = z.object({
  hex: z.string().regex(/^[a-f0-9]{64}$/),
  colonSeparated: z.string().regex(/^([a-f0-9]{2}:){31}[a-f0-9]{2}$/),
  words: z.array(z.string()).length(FINGERPRINT_WORD_COUNT),
  shortCode: z.string().length(FINGERPRINT_SHORT_CODE_LENGTH),
  hashAlgorithm: z.literal('sha256'),
});

export const DeviceIdentitySchema = z.object({
  deviceId: z
    .string()
    .startsWith(DEVICE_ID_PREFIX)
    .length(DEVICE_ID_PREFIX.length + DEVICE_ID_LENGTH),
  gatewayId: z
    .string()
    .startsWith('gw_')
    .length(24 + 3),
  publicKeyJwk: JwkSchema,
  publicKeyPem: z.string().min(1),
  fingerprint: DeviceFingerprintSchema,
  algorithm: KeyAlgorithmSchema,
  createdAt: z.coerce.date(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const DeviceStatusSchema = z.enum([
  'unpaired',
  'pairing',
  'trusted',
  'suspended',
  'revoked',
]);

export const DeviceCertificateSchema = z.object({
  id: z
    .string()
    .startsWith(CERT_ID_PREFIX)
    .length(CERT_ID_PREFIX.length + CERT_ID_LENGTH),
  deviceId: z
    .string()
    .startsWith(DEVICE_ID_PREFIX)
    .length(DEVICE_ID_PREFIX.length + DEVICE_ID_LENGTH),
  certificatePem: z.string().min(1),
  serialNumber: z.string().min(1),
  issuedAt: z.coerce.date(),
  expiresAt: z.coerce.date(),
  issuer: z.string().min(1),
  subject: z.string().min(1),
  thumbprint: z.string().regex(/^[a-f0-9]{64}$/),
  signatureAlgorithm: z.string().min(1),
});

export const CertificateChainSchema = z.object({
  leaf: DeviceCertificateSchema,
  intermediate: DeviceCertificateSchema.optional(),
  root: z.object({
    certificatePem: z.string().min(1),
    subject: z.string().min(1),
    thumbprint: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});

export const RevocationReasonSchema = z.enum([
  'user_initiated',
  'compromise_suspected',
  'device_replaced',
  'policy_violation',
  'expired_unrenewed',
]);

export const RevocationStatusSchema = z.object({
  deviceId: z
    .string()
    .startsWith(DEVICE_ID_PREFIX)
    .length(DEVICE_ID_PREFIX.length + DEVICE_ID_LENGTH),
  revoked: z.boolean(),
  revokedAt: z.coerce.date().optional(),
  reason: RevocationReasonSchema.optional(),
  revokedBy: z.string().optional(),
  revocationNote: z.string().optional(),
  affectedCertificates: z.array(z.string()),
});

export const PairingCodeSchema = z.object({
  code: z.string().length(PAIRING_CODE_LENGTH),
  expiresAt: z.coerce.date(),
  issuedAt: z.coerce.date(),
  deviceId: z
    .string()
    .startsWith(DEVICE_ID_PREFIX)
    .length(DEVICE_ID_PREFIX.length + DEVICE_ID_LENGTH),
  publicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  qrPayload: z.string().optional(),
});

export const SignedHandshakeSchema = z.object({
  deviceId: z
    .string()
    .startsWith(DEVICE_ID_PREFIX)
    .length(DEVICE_ID_PREFIX.length + DEVICE_ID_LENGTH),
  nonce: z.string().min(1),
  timestamp: z.coerce.date(),
  signature: z.string().min(1),
  publicKeyJwk: JwkSchema,
  certificateThumbprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

export const SessionReconciliationStateSchema = z.object({
  sessionId: z
    .string()
    .startsWith('sess_')
    .length(24 + 5),
  lastAckedSequence: z.number().int().nonnegative(),
  lastEventAt: z.coerce.date().optional(),
  state: z.string().min(1),
  lastEventType: z.string().optional(),
});

export const ReconciliationRequestSchema = z.object({
  deviceId: z
    .string()
    .startsWith(DEVICE_ID_PREFIX)
    .length(DEVICE_ID_PREFIX.length + DEVICE_ID_LENGTH),
  gatewayId: z
    .string()
    .startsWith('gw_')
    .length(24 + 3),
  lastAckedGlobalSequence: z.number().int().nonnegative(),
  sessionStates: z.array(SessionReconciliationStateSchema),
  certificateThumbprint: z.string().regex(/^[a-f0-9]{64}$/),
  signedAt: z.coerce.date(),
  signature: z.string().min(1),
});

export const ReconciliationResponseSchema = z.object({
  deviceId: z
    .string()
    .startsWith(DEVICE_ID_PREFIX)
    .length(DEVICE_ID_PREFIX.length + DEVICE_ID_LENGTH),
  replayEvents: z.array(
    z.object({
      sequence: z.number().int().nonnegative(),
      event: z.unknown(),
    }),
  ),
  sessionUpdates: z.array(
    z.object({
      sessionId: z
        .string()
        .startsWith('sess_')
        .length(24 + 5),
      newState: z.string().optional(),
      missingApprovalDecisions: z.array(z.unknown()).optional(),
      unrecoverableGaps: z
        .array(
          z.object({
            from: z.number().int().nonnegative(),
            to: z.number().int().nonnegative(),
            reason: z.string(),
          }),
        )
        .optional(),
    }),
  ),
  globalGapInfo: z
    .object({
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
      reason: z.string(),
    })
    .optional(),
  reconciledAt: z.coerce.date(),
  newAckBaseline: z.number().int().nonnegative(),
});

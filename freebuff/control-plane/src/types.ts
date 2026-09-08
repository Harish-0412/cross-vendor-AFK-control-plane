import type {
  DeviceStatus,
  EventEnvelope,
  NotificationPreferences,
  SessionConfig,
  SessionState,
  TrustProfile,
} from '@freebuff/protocol';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  role: 'user' | 'admin' | 'owner';
  metadata?: Record<string, unknown>;
  notificationPreferences?: NotificationPreferences;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeviceRecord {
  id: string; // dev_...
  userId: string;
  gatewayId: string;
  friendlyName: string;
  platform: 'windows' | 'linux' | 'darwin' | 'unknown';
  publicKeyPem: string;
  publicKeyJwk: Record<string, unknown>;
  fingerprintHex: string;
  fingerprintWords: string[];
  status: DeviceStatus; // 'unpaired' | 'pairing' | 'trusted' | 'suspended' | 'revoked'
  defaultTrustProfile: TrustProfile;
  lastSeenAt?: Date | undefined;
  createdAt: Date;
  updatedAt: Date;
  systemInfo?:
    | {
        hostname?: string | undefined;
        arch?: string | undefined;
        nodeVersion?: string | undefined;
        gatewayVersion?: string | undefined;
      }
    | undefined;
  resourceUsage?:
    | {
        cpuPercent?: number | undefined;
        memoryMb?: number | undefined;
        memoryPeakMb?: number | undefined;
        activeProcesses?: number | undefined;
        diskFreeMb?: number | undefined;
      }
    | undefined;
}

export type PairingSessionStatus =
  'pending' | 'code_verified' | 'confirmed' | 'expired' | 'rejected';

export interface PairingSession {
  id: string;
  code: string; // e.g. "T55Q-Y3D2"
  deviceId: string;
  gatewayId: string;
  userId?: string | undefined;
  fingerprintHex: string;
  fingerprintWords: string[];
  status: PairingSessionStatus;
  expiresAt: Date;
  createdAt: Date;
  confirmedAt?: Date | undefined;
}

export interface SessionRecord {
  id: string; // sess_...
  userId: string;
  deviceId: string;
  gatewayId: string;
  agentId: string;
  projectRoot: string;
  state: SessionState;
  trustProfile: TrustProfile;
  config: SessionConfig;
  startedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date | undefined;
  error?: string | undefined;
  tokensUsed?: number | undefined;
}

export interface PushSubscriptionRecord {
  id: string;
  userId: string;
  channel: 'web-push' | 'fcm';
  endpoint?: string;
  keys?: { p256dh: string; auth: string };
  fcmToken?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalRecord {
  id: string;
  sessionId: string;
  deviceId: string;
  userId: string;
  actionType: string;
  description: string;
  details?: Record<string, unknown> | undefined;
  status: 'pending' | 'granted' | 'denied' | 'timeout' | 'superseded';
  requestedAt: Date;
  decidedAt?: Date | undefined;
  decidedBy?: string | undefined;
  reason?: string | undefined;
  // Policy Engine extensions (Phase 5)
  policyVersion?: string | undefined;
  matchedRules?: string[] | undefined;
  requiredRole?: 'owner' | 'admin' | undefined;
  expiresAt?: Date | undefined;
}

export interface StoredEvent {
  id: string;
  sessionId: string;
  deviceId: string;
  sequence: number;
  eventType: string;
  envelope: EventEnvelope;
  storedAt: Date;
}

export interface AuditEvent {
  id: string;
  sequence: number;
  timestamp: Date;
  actor: { type: 'user' | 'device' | 'system'; id: string };
  sessionId?: string;
  deviceId?: string;
  action: string;
  decision: 'allow' | 'deny' | 'require_approval' | 'granted' | 'denied' | 'timeout';
  policyVersion?: string;
  matchedRules?: string[];
  previousHash: string;
  hash: string;
}

export interface ControlPlaneConfig {
  host: string;
  port: number;
  jwtSecret: string;
  jwtExpiresInSec: number;
  refreshTokenExpiresInSec: number;
  corsOrigins: string[];
  pairingCodeTtlSec: number;
  heartbeatTimeoutMs: number;
}

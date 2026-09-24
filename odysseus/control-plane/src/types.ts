import type {
  DeviceStatus,
  EventEnvelope,
  NotificationPreferences,
  SessionConfig,
  SessionState,
  TrustProfile,
  GitReviewBundle,
  ProjectPreferences,
  AgentCapabilities,
} from '@odysseus/protocol';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  role: 'user' | 'admin' | 'owner';
  /**
   * Account lifecycle. `suspended` accounts fail login, token refresh, and
   * pairing — but their records stay, so an admin can restore them. The
   * field is optional only for backward compatibility with records written
   * before it existed; every read treats an absent value as 'active'.
   */
  status?: 'active' | 'suspended';
  /** Set by the admin who suspended the account; shown in the admin UI. */
  suspendedReason?: string | undefined;
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
  /** Advertised by the authenticated gateway; used only for routing eligibility. */
  availableAgents?: Array<{ id: string; capabilities: Partial<AgentCapabilities> }>;
}

export type PairingSessionStatus =
  'pending' | 'code_verified' | 'confirmed' | 'expired' | 'rejected';

export interface PairingSession {
  id: string;
  code: string; // e.g. "T55Q-Y3D2"
  deviceId: string;
  gatewayId: string;
  /** Human-recognisable name reported locally when the short-lived code is created. */
  deviceName?: string | undefined;
  platform?: DeviceRecord['platform'] | undefined;
  userId?: string | undefined;
  fingerprintHex: string;
  fingerprintWords: string[];
  /**
   * The device public key, captured at pairing time.
   *
   * The tunnel handshake verifies signatures against this key, so a pairing
   * that does not carry one produces a device that can never authenticate.
   */
  publicKeyJwk?: Record<string, unknown> | undefined;
  publicKeyPem?: string | undefined;
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
  projectId?: string | undefined;
  organizationId?: string | undefined;
  state: SessionState;
  trustProfile: TrustProfile;
  config: SessionConfig;
  startedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date | undefined;
  error?: string | undefined;
  tokensUsed?: number | undefined;
  reviewBundle?: GitReviewBundle | undefined;
}

export interface ProjectRecord {
  id: string;
  userId: string;
  name: string;
  root: string;
  organizationId?: string | undefined;
  preferences: ProjectPreferences;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationRecord {
  id: string;
  name: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationMembership {
  organizationId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member';
  createdAt: Date;
}

export interface CostEventRecord {
  id: string;
  sessionId: string;
  projectId?: string;
  organizationId?: string;
  userId: string;
  tokens: number;
  costUsd: number;
  /**
   * How the tokens were paid for. Subscription tokens (a ChatGPT plan, say) count
   * toward token budgets but carry no per-token dollar cost, so costUsd is 0 —
   * recording an estimated price would invent a figure nobody was charged.
   */
  billing?: 'metered' | 'subscription' | undefined;
  recordedAt: Date;
}

export interface IntegrationCredentialRecord {
  id: string;
  userId: string;
  provider: 'github' | 'gitlab' | 'bitbucket';
  ciphertext: string;
  iv: string;
  authTag: string;
  createdAt: Date;
  updatedAt: Date;
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
  /** Recorded before delivery so restart reconciliation cannot send a duplicate reminder. */
  reminderSentAt?: Date | undefined;
  /** Optional escalation hook checkpoint (for an email/Slack fallback integration). */
  fallbackTriggeredAt?: Date | undefined;
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
  githubClientId?: string;
  githubClientSecret?: string;
  githubCallbackUrl?: string;
  gitlabClientId?: string;
  gitlabClientSecret?: string;
  gitlabCallbackUrl?: string;
  bitbucketClientId?: string;
  bitbucketClientSecret?: string;
  bitbucketCallbackUrl?: string;
  /** Canonical control-centre origin used after a successful OAuth callback. */
  frontendUrl?: string;
  credentialEncryptionSecret?: string;
  /**
   * Whether the refresh-token cookie gets the `Secure` attribute (§4.5 of
   * the pre-deployment audit — it was missing entirely, so the cookie could
   * be sent in the clear over a misconfigured/non-TLS connection). Defaults
   * to `NODE_ENV === 'production'`. Explicit override exists because a
   * proxy-terminated-TLS deployment may need this true even when
   * `NODE_ENV` isn't set to `production` in the app process itself, or a
   * staging environment may want it true to catch cookie-handling bugs
   * before production.
   */
  secureCookies: boolean;
}

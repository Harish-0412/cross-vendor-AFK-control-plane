import type {
  BudgetLimit,
  ExternalConversationSummary,
  GrantStatus,
  HistoryItem,
  IntegrationId,
  IntegrationScope,
  OrchestrationRun,
  ProviderUsageSnapshot,
  RoutingDecision,
} from '@odysseus/protocol';

import type {
  User,
  DeviceRecord,
  PairingSession,
  SessionRecord,
  ApprovalRecord,
  StoredEvent,
  PushSubscriptionRecord,
  AuditEvent,
  ProjectRecord,
  IntegrationCredentialRecord,
  OrganizationRecord,
  OrganizationMembership,
  CostEventRecord,
} from '../types';

export interface IUserRepository {
  create(
    user: Omit<User, 'id' | 'createdAt' | 'updatedAt' | 'passwordHash'> & {
      id?: string;
      passwordHash?: string;
    },
  ): Promise<User>;
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  list(): Promise<User[]>;
  update(id: string, updates: Partial<User>): Promise<User | null>;
  /**
   * Hard-delete a user record. Used only by the admin destroy action, which
   * is audited and refuses to run on the last admin/owner. Returns whether
   * a record was actually removed.
   */
  delete(id: string): Promise<boolean>;
}

export type CreateDeviceRecord = Omit<
  DeviceRecord,
  'createdAt' | 'updatedAt' | 'defaultTrustProfile'
> & { defaultTrustProfile?: DeviceRecord['defaultTrustProfile'] };

export type CreateSessionRecord = Omit<
  SessionRecord,
  'createdAt' | 'updatedAt' | 'trustProfile'
> & { trustProfile?: SessionRecord['trustProfile'] };

export interface IDeviceRepository {
  create(device: CreateDeviceRecord): Promise<DeviceRecord>;
  findById(id: string): Promise<DeviceRecord | null>;
  findByGatewayId(gatewayId: string): Promise<DeviceRecord | null>;
  listByUser(userId: string): Promise<DeviceRecord[]>;
  update(id: string, updates: Partial<DeviceRecord>): Promise<DeviceRecord | null>;
  updateStatus(id: string, status: DeviceRecord['status']): Promise<DeviceRecord | null>;
  updateLastSeen(id: string, lastSeenAt?: Date): Promise<DeviceRecord | null>;
  updateResourceUsage(
    id: string,
    usage: DeviceRecord['resourceUsage'],
  ): Promise<DeviceRecord | null>;
  delete(id: string): Promise<boolean>;
}

export interface IPairingRepository {
  create(pairing: Omit<PairingSession, 'id' | 'createdAt'>): Promise<PairingSession>;
  findById(id: string): Promise<PairingSession | null>;
  findByCode(code: string): Promise<PairingSession | null>;
  findByDeviceId(deviceId: string): Promise<PairingSession | null>;
  update(id: string, updates: Partial<PairingSession>): Promise<PairingSession | null>;
  delete(id: string): Promise<boolean>;
}

export interface ISessionRepository {
  create(session: CreateSessionRecord): Promise<SessionRecord>;
  findById(id: string): Promise<SessionRecord | null>;
  listByUser(
    userId: string,
    filter?: {
      deviceId?: string | undefined;
      state?: string | undefined;
      agentId?: string | undefined;
    },
  ): Promise<SessionRecord[]>;
  listByDevice(deviceId: string): Promise<SessionRecord[]>;
  update(id: string, updates: Partial<SessionRecord>): Promise<SessionRecord | null>;
}

export interface IProjectRepository {
  create(project: Omit<ProjectRecord, 'createdAt' | 'updatedAt'>): Promise<ProjectRecord>;
  findById(id: string): Promise<ProjectRecord | null>;
  findByRoot(userId: string, root: string): Promise<ProjectRecord | null>;
  listByUser(userId: string): Promise<ProjectRecord[]>;
  update(id: string, updates: Partial<ProjectRecord>): Promise<ProjectRecord | null>;
}

export interface IIntegrationCredentialRepository {
  upsert(
    record: Omit<IntegrationCredentialRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IntegrationCredentialRecord>;
  find(
    userId: string,
    provider: IntegrationCredentialRecord['provider'],
  ): Promise<IntegrationCredentialRecord | null>;
  delete(userId: string, provider: IntegrationCredentialRecord['provider']): Promise<boolean>;
}

export interface IOrganizationRepository {
  create(
    organization: Omit<OrganizationRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<OrganizationRecord>;
  findById(id: string): Promise<OrganizationRecord | null>;
  listByUser(userId: string): Promise<OrganizationRecord[]>;
  addMember(membership: Omit<OrganizationMembership, 'createdAt'>): Promise<OrganizationMembership>;
  getMembership(organizationId: string, userId: string): Promise<OrganizationMembership | null>;
  listMembers(organizationId: string): Promise<OrganizationMembership[]>;
}

export interface IOrchestrationRepository {
  createRun(run: OrchestrationRun): Promise<OrchestrationRun>;
  findRun(id: string): Promise<OrchestrationRun | null>;
  listRuns(organizationId: string, projectId?: string): Promise<OrchestrationRun[]>;
  updateRun(id: string, update: Partial<OrchestrationRun>): Promise<OrchestrationRun | null>;
  appendRoutingDecision(decision: RoutingDecision): Promise<RoutingDecision>;
  listRoutingDecisions(projectId: string, limit?: number): Promise<RoutingDecision[]>;
  upsertBudget(budget: BudgetLimit): Promise<BudgetLimit>;
  listBudgets(scope: BudgetLimit['scope'], scopeId: string): Promise<BudgetLimit[]>;
  appendCost(event: Omit<CostEventRecord, 'id' | 'recordedAt'>): Promise<CostEventRecord>;
  listCosts(options: {
    sessionId?: string;
    projectId?: string;
    organizationId?: string;
  }): Promise<CostEventRecord[]>;
}

export interface IEventRepository {
  /**
   * Append an event, idempotently.
   *
   * Duplicate delivery is normal, not exceptional: the tunnel replays queued
   * events after a reconnect, and once a device holds more than one
   * connection the same event can arrive over either. Re-appending would
   * inflate counts and show the user the same output twice.
   *
   * The idempotency key is `envelope.eventId`, which is minted once at the
   * source and is stable across every redelivery. It is deliberately NOT
   * (sessionId, sequence): sequences are allocated per session by the
   * gateway, and keying on them would merge two genuinely different events
   * that happened to share a number.
   *
   * Returns the previously stored event when one already exists.
   */
  append(event: Omit<StoredEvent, 'id' | 'storedAt'>): Promise<StoredEvent>;
  listBySession(sessionId: string, fromSequence?: number, limit?: number): Promise<StoredEvent[]>;
  getHighestSequence(sessionId: string): Promise<number>;
}

export interface IApprovalRepository {
  create(approval: Omit<ApprovalRecord, 'id' | 'requestedAt'>): Promise<ApprovalRecord>;
  findById(id: string): Promise<ApprovalRecord | null>;
  listBySession(sessionId: string): Promise<ApprovalRecord[]>;
  listByUser(userId: string, status?: string): Promise<ApprovalRecord[]>;
  listPending(userId: string): Promise<ApprovalRecord[]>;
  /** Pending approvals for every user; used to rebuild timers after a process restart. */
  listAllPending(): Promise<ApprovalRecord[]>;
  update(id: string, updates: Partial<ApprovalRecord>): Promise<ApprovalRecord | null>;
}

export interface IPushSubscriptionRepository {
  upsert(
    subscription: Omit<PushSubscriptionRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<PushSubscriptionRecord>;
  listByUser(userId: string): Promise<PushSubscriptionRecord[]>;
  delete(userId: string, target: string): Promise<boolean>;
}

export interface IAuditRepository {
  append(event: Omit<AuditEvent, 'id' | 'sequence' | 'hash' | 'previousHash'>): Promise<AuditEvent>;
  list(options?: {
    sessionId?: string;
    deviceId?: string;
    actorType?: string;
    actorId?: string;
    decision?: string;
    fromSequence?: number;
    limit?: number;
  }): Promise<AuditEvent[]>;
  getHighestSequence(): Promise<number>;
  findById(id: string): Promise<AuditEvent | null>;
  verifyChain():
    | Promise<{ valid: boolean; firstBrokenIndex?: number }>
    | { valid: boolean; firstBrokenIndex?: number };
}

export interface IDatabase {
  users: IUserRepository;
  devices: IDeviceRepository;
  pairings: IPairingRepository;
  sessions: ISessionRepository;
  projects: IProjectRepository;
  integrationCredentials: IIntegrationCredentialRepository;
  organizations: IOrganizationRepository;
  orchestration: IOrchestrationRepository;
  events: IEventRepository;
  approvals: IApprovalRepository;
  pushSubscriptions: IPushSubscriptionRepository;
  audit: IAuditRepository;
  integrationGrants: IIntegrationGrantRepository;
  externalConversations: IExternalConversationRepository;
  providerUsage: IProviderUsageRepository;
}

/**
 * The Control Plane's copy of each device's integration grants, for display.
 *
 * The authority is the gateway: it holds the signed grant and checks it before
 * every read. This copy only lets the web app show status — nothing is ever
 * granted because a record here says so.
 */
export interface IntegrationGrantRecord {
  deviceId: string;
  userId: string;
  integration: IntegrationId;
  status: GrantStatus;
  scopes: IntegrationScope[];
  requestId?: string | undefined;
  grantId?: string | undefined;
  roots?: string[] | undefined;
  grantedAt?: string | undefined;
  expiresAt?: string | undefined;
  reason?: string | undefined;
  updatedAt: Date;
}

export interface IIntegrationGrantRepository {
  upsert(record: Omit<IntegrationGrantRecord, 'updatedAt'>): Promise<IntegrationGrantRecord>;
  listByDevice(deviceId: string): Promise<IntegrationGrantRecord[]>;
  find(deviceId: string, integration: IntegrationId): Promise<IntegrationGrantRecord | null>;
}

/** A past conversation imported from an external tool (Codex, Antigravity, …). */
export interface ExternalConversationRecord extends Omit<
  ExternalConversationSummary,
  'integration'
> {
  /** `${integration}_${deviceId}_${externalId}` */
  id: string;
  integration: IntegrationId;
  deviceId: string;
  userId: string;
  contentSynced: boolean;
  contentSyncedAt?: string | undefined;
  contentTruncated?: boolean | undefined;
  /** Tokens already passed to the CostGovernor, so a re-sync records only the difference. */
  tokensRecorded: number;
  /**
   * Message text, capped at HISTORY_LIMITS.searchTextChars, built when content
   * is synced. Searching reads this instead of every item, which
   * keeps a search one read per conversation rather than one per chunk.
   * Absent until content has been synced — those conversations are searchable
   * by title only, and the API says how many there are.
   */
  searchText?: string | undefined;
  /** The scan that last saw this conversation; older ones are removed on a complete scan. */
  lastScanId: string;
  updatedRecordAt: Date;
}

export interface IExternalConversationRepository {
  upsert(record: ExternalConversationRecord): Promise<void>;
  find(id: string): Promise<ExternalConversationRecord | null>;
  listByUser(
    userId: string,
    filter?: {
      integration?: IntegrationId | undefined;
      deviceId?: string | undefined;
    },
  ): Promise<ExternalConversationRecord[]>;
  listByDeviceIntegration(
    deviceId: string,
    integration: IntegrationId,
  ): Promise<ExternalConversationRecord[]>;
  /** Replace (part 0) or extend (later parts) a conversation's synced content. */
  writeItems(id: string, part: number, items: HistoryItem[]): Promise<void>;
  readItems(id: string): Promise<HistoryItem[]>;
  /** Remove conversations and their content. */
  delete(ids: string[]): Promise<void>;
}

export interface ProviderUsageRecord {
  deviceId: string;
  userId: string;
  integration: IntegrationId;
  snapshot: ProviderUsageSnapshot;
  receivedAt: Date;
  /**
   * Window name → the `resetsAt` of the window already alerted on. A window is
   * alerted once per reset; when it resets, `resetsAt` changes and the next
   * crossing alerts again. Keeping it on the record means the dedupe survives
   * a restart, unlike an in-memory set.
   */
  alertedWindows?: Record<string, string> | undefined;
}

export interface IProviderUsageRepository {
  upsert(record: ProviderUsageRecord): Promise<void>;
  listByUser(userId: string): Promise<ProviderUsageRecord[]>;
  /** The stored record for one device+integration, or null. */
  find(deviceId: string, integration: IntegrationId): Promise<ProviderUsageRecord | null>;
  delete(deviceId: string, integration: IntegrationId): Promise<void>;
}

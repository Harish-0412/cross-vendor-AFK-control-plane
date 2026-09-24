import crypto, { randomUUID } from 'node:crypto';

import type {
  BudgetLimit,
  HistoryItem,
  OrchestrationRun,
  RoutingDecision,
} from '@odysseus/protocol';

import type {
  User,
  DeviceRecord,
  PairingSession,
  SessionRecord,
  ApprovalRecord,
  StoredEvent,
  AuditEvent,
  PushSubscriptionRecord,
  ProjectRecord,
  IntegrationCredentialRecord,
  OrganizationRecord,
  OrganizationMembership,
  CostEventRecord,
} from '../types';

import { normalizePairingCode } from './pairing-code';
import type {
  IIntegrationGrantRepository,
  IntegrationGrantRecord,
  IExternalConversationRepository,
  ExternalConversationRecord,
  IProviderUsageRepository,
  ProviderUsageRecord,
  IDatabase,
  IUserRepository,
  IDeviceRepository,
  IPairingRepository,
  ISessionRepository,
  IEventRepository,
  IApprovalRepository,
  IAuditRepository,
  IPushSubscriptionRepository,
  CreateDeviceRecord,
  CreateSessionRecord,
  IProjectRepository,
  IIntegrationCredentialRepository,
  IOrganizationRepository,
  IOrchestrationRepository,
} from './types';

export class MemoryUserRepository implements IUserRepository {
  private users = new Map<string, User>();

  async create(
    data: Omit<User, 'id' | 'createdAt' | 'updatedAt' | 'passwordHash'> & {
      id?: string;
      passwordHash?: string;
    },
  ): Promise<User> {
    const now = new Date();
    const user: User = {
      id: data.id || `usr_${randomUUID().replace(/-/g, '')}`,
      ...data,
      passwordHash: data.passwordHash ?? '',
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(user.id, user);
    return user;
  }

  async findById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const normalized = email.toLowerCase().trim();
    for (const user of this.users.values()) {
      if (user.email.toLowerCase().trim() === normalized) {
        return user;
      }
    }
    return null;
  }

  async list(): Promise<User[]> {
    return Array.from(this.users.values());
  }

  async update(id: string, updates: Partial<User>): Promise<User | null> {
    const user = this.users.get(id);
    if (!user) return null;
    Object.assign(user, updates, { updatedAt: new Date() });
    return user;
  }

  async delete(id: string): Promise<boolean> {
    return this.users.delete(id);
  }
}

export class MemoryDeviceRepository implements IDeviceRepository {
  private devices = new Map<string, DeviceRecord>();

  async create(data: CreateDeviceRecord): Promise<DeviceRecord> {
    const now = new Date();
    const device: DeviceRecord = {
      ...data,
      defaultTrustProfile: data.defaultTrustProfile ?? 'default',
      createdAt: now,
      updatedAt: now,
    };
    this.devices.set(device.id, device);
    return device;
  }

  async findById(id: string): Promise<DeviceRecord | null> {
    return this.devices.get(id) ?? null;
  }

  async findByGatewayId(gatewayId: string): Promise<DeviceRecord | null> {
    for (const dev of this.devices.values()) {
      if (dev.gatewayId === gatewayId) return dev;
    }
    return null;
  }

  async listByUser(userId: string): Promise<DeviceRecord[]> {
    return Array.from(this.devices.values()).filter((d) => d.userId === userId);
  }

  async update(id: string, updates: Partial<DeviceRecord>): Promise<DeviceRecord | null> {
    const dev = this.devices.get(id);
    if (!dev) return null;
    Object.assign(dev, updates, { updatedAt: new Date() });
    return dev;
  }

  async updateStatus(id: string, status: DeviceRecord['status']): Promise<DeviceRecord | null> {
    const dev = this.devices.get(id);
    if (!dev) return null;
    dev.status = status;
    dev.updatedAt = new Date();
    return dev;
  }

  async updateLastSeen(id: string, lastSeenAt = new Date()): Promise<DeviceRecord | null> {
    const dev = this.devices.get(id);
    if (!dev) return null;
    dev.lastSeenAt = lastSeenAt;
    dev.updatedAt = new Date();
    return dev;
  }

  async updateResourceUsage(
    id: string,
    usage: DeviceRecord['resourceUsage'],
  ): Promise<DeviceRecord | null> {
    const dev = this.devices.get(id);
    if (!dev) return null;
    dev.resourceUsage = usage;
    dev.updatedAt = new Date();
    return dev;
  }

  async delete(id: string): Promise<boolean> {
    return this.devices.delete(id);
  }
}

export class MemoryPairingRepository implements IPairingRepository {
  private pairings = new Map<string, PairingSession>();

  async create(data: Omit<PairingSession, 'id' | 'createdAt'>): Promise<PairingSession> {
    const now = new Date();
    const pairing: PairingSession = {
      id: `pair_${randomUUID().replace(/-/g, '')}`,
      ...data,
      createdAt: now,
    };
    this.pairings.set(pairing.id, pairing);
    return pairing;
  }

  async findById(id: string): Promise<PairingSession | null> {
    return this.pairings.get(id) ?? null;
  }

  async findByCode(code: string): Promise<PairingSession | null> {
    // Both sides go through the same normaliser. Comparing a dash-stripped
    // lookup against a raw stored code is what broke pairing before.
    const normalized = normalizePairingCode(code);
    for (const p of this.pairings.values()) {
      if (normalizePairingCode(p.code) === normalized) {
        return p;
      }
    }
    return null;
  }

  async findByDeviceId(deviceId: string): Promise<PairingSession | null> {
    for (const p of this.pairings.values()) {
      if (p.deviceId === deviceId && p.status !== 'expired' && p.status !== 'rejected') {
        return p;
      }
    }
    return null;
  }

  async update(id: string, updates: Partial<PairingSession>): Promise<PairingSession | null> {
    const p = this.pairings.get(id);
    if (!p) return null;
    Object.assign(p, updates);
    return p;
  }

  async delete(id: string): Promise<boolean> {
    return this.pairings.delete(id);
  }
}

export class MemorySessionRepository implements ISessionRepository {
  private sessions = new Map<string, SessionRecord>();

  async create(data: CreateSessionRecord): Promise<SessionRecord> {
    const now = new Date();
    const session: SessionRecord = {
      ...data,
      trustProfile: data.trustProfile ?? 'default',
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async findById(id: string): Promise<SessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }

  async listByUser(
    userId: string,
    filter?: {
      deviceId?: string | undefined;
      state?: string | undefined;
      agentId?: string | undefined;
    },
  ): Promise<SessionRecord[]> {
    return Array.from(this.sessions.values()).filter((s) => {
      if (s.userId !== userId) return false;
      if (filter?.deviceId && s.deviceId !== filter.deviceId) return false;
      if (filter?.state && s.state !== filter.state) return false;
      if (filter?.agentId && s.agentId !== filter.agentId) return false;
      return true;
    });
  }

  async listByDevice(deviceId: string): Promise<SessionRecord[]> {
    return Array.from(this.sessions.values()).filter((s) => s.deviceId === deviceId);
  }

  async update(id: string, updates: Partial<SessionRecord>): Promise<SessionRecord | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    Object.assign(s, updates);
    s.updatedAt = new Date();
    return s;
  }
}

export class MemoryProjectRepository implements IProjectRepository {
  private projects = new Map<string, ProjectRecord>();

  async create(data: Omit<ProjectRecord, 'createdAt' | 'updatedAt'>): Promise<ProjectRecord> {
    const now = new Date();
    const project = { ...data, createdAt: now, updatedAt: now };
    this.projects.set(project.id, project);
    return project;
  }

  async findById(id: string): Promise<ProjectRecord | null> {
    return this.projects.get(id) ?? null;
  }
  async findByRoot(userId: string, root: string): Promise<ProjectRecord | null> {
    return (
      [...this.projects.values()].find(
        (project) => project.userId === userId && project.root === root,
      ) ?? null
    );
  }
  async listByUser(userId: string): Promise<ProjectRecord[]> {
    return [...this.projects.values()].filter((project) => project.userId === userId);
  }
  async update(id: string, updates: Partial<ProjectRecord>): Promise<ProjectRecord | null> {
    const project = this.projects.get(id);
    if (!project) return null;
    Object.assign(project, updates, { updatedAt: new Date() });
    return project;
  }
}

export class MemoryIntegrationCredentialRepository implements IIntegrationCredentialRepository {
  private records = new Map<string, IntegrationCredentialRecord>();
  private key(userId: string, provider: string): string {
    return `${provider}:${userId}`;
  }
  async upsert(
    data: Omit<IntegrationCredentialRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IntegrationCredentialRecord> {
    const key = this.key(data.userId, data.provider);
    const existing = this.records.get(key);
    const now = new Date();
    const record = {
      ...data,
      id: existing?.id ?? `cred_${randomUUID().replace(/-/g, '')}`,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.records.set(key, record);
    return record;
  }
  async find(
    userId: string,
    provider: IntegrationCredentialRecord['provider'],
  ): Promise<IntegrationCredentialRecord | null> {
    return this.records.get(this.key(userId, provider)) ?? null;
  }
  async delete(
    userId: string,
    provider: IntegrationCredentialRecord['provider'],
  ): Promise<boolean> {
    return this.records.delete(this.key(userId, provider));
  }
}

export class MemoryEventRepository implements IEventRepository {
  private events: StoredEvent[] = [];
  /** eventId -> stored event, so redelivery is a lookup rather than a scan. */
  private byEventId = new Map<string, StoredEvent>();

  async append(data: Omit<StoredEvent, 'id' | 'storedAt'>): Promise<StoredEvent> {
    // See IEventRepository.append: the key is the envelope's eventId, which
    // is stable across replay and unique per event.
    const eventId = data.envelope?.eventId;
    if (eventId) {
      const existing = this.byEventId.get(eventId);
      if (existing) return existing;
    }

    const event: StoredEvent = {
      id: `evt_${randomUUID().replace(/-/g, '')}`,
      ...data,
      storedAt: new Date(),
    };
    this.events.push(event);
    if (eventId) this.byEventId.set(eventId, event);
    return event;
  }

  async listBySession(sessionId: string, fromSequence = 0, limit = 1000): Promise<StoredEvent[]> {
    return this.events
      .filter((e) => e.sessionId === sessionId && e.sequence >= fromSequence)
      .slice(0, limit);
  }

  async getHighestSequence(sessionId: string): Promise<number> {
    let max = 0;
    for (const e of this.events) {
      if (e.sessionId === sessionId && e.sequence > max) {
        max = e.sequence;
      }
    }
    return max;
  }
}

export class MemoryAuditRepository implements IAuditRepository {
  private events: AuditEvent[] = [];
  private nextSequence = 1;

  async append(
    data: Omit<AuditEvent, 'id' | 'sequence' | 'hash' | 'previousHash'>,
  ): Promise<AuditEvent> {
    const previousHash = this.events.at(-1)?.hash ?? '0'.repeat(64);
    const entry = {
      ...data,
      previousHash,
    };
    const canonical = this.canonicalize(entry);
    const hash = this.computeHash(canonical);
    const event: AuditEvent = {
      id: `aud_${randomUUID().replace(/-/g, '')}`,
      sequence: this.nextSequence++,
      hash,
      ...entry,
    };
    this.events.push(event);
    return event;
  }

  async list(options?: {
    sessionId?: string;
    deviceId?: string;
    actorType?: string;
    actorId?: string;
    decision?: string;
    fromSequence?: number;
    limit?: number;
  }): Promise<AuditEvent[]> {
    let result = this.events;
    if (options?.sessionId) result = result.filter((e) => e.sessionId === options.sessionId);
    if (options?.deviceId) result = result.filter((e) => e.deviceId === options.deviceId);
    if (options?.actorType) result = result.filter((e) => e.actor.type === options.actorType);
    if (options?.actorId) result = result.filter((e) => e.actor.id === options.actorId);
    if (options?.decision) result = result.filter((e) => e.decision === options.decision);
    const fromSequence = options?.fromSequence;
    if (fromSequence !== undefined) result = result.filter((e) => e.sequence >= fromSequence);
    if (options?.limit) result = result.slice(-options.limit);
    return result;
  }

  async getHighestSequence(): Promise<number> {
    if (this.events.length === 0) return 0;
    return this.events[this.events.length - 1]!.sequence;
  }

  async findById(id: string): Promise<AuditEvent | null> {
    return this.events.find((e) => e.id === id) ?? null;
  }

  /** Verify hash chain integrity. Returns { valid, firstBrokenIndex } */
  verifyChain(): { valid: boolean; firstBrokenIndex?: number } {
    for (let i = 0; i < this.events.length; i++) {
      const evt = this.events[i]!;
      const expectedPrevHash = i === 0 ? '0'.repeat(64) : this.events[i - 1]!.hash;
      if (evt.previousHash !== expectedPrevHash) {
        return { valid: false, firstBrokenIndex: i };
      }
      // Recompute: canonicalize without hash field, append previousHash.
      // `hash` is destructured out on purpose (to exclude it from `rest`
      // before re-hashing) and never read directly — `evt.hash` is used
      // below instead — hence the `_`-prefixed name to tell the linter this
      // binding is intentionally unused, not a forgotten one.
      //
      // `id` and `sequence` are stripped for the same reason: append()
      // computed the hash over `{...data, previousHash}` BEFORE the record
      // was assigned its id and sequence, so re-hashing with them included
      // made every intact chain verify as broken (firstBrokenIndex 0) the
      // moment the log held any event at all.
      const {
        hash: _hash,
        id: _id,
        sequence: _sequence,
        ...rest
      } = evt;
      const canonical = this.canonicalize(rest);
      const recomputed = this.computeHash(canonical);
      if (recomputed !== evt.hash) {
        return { valid: false, firstBrokenIndex: i };
      }
    }
    return { valid: true };
  }

  private canonicalize(entry: Record<string, unknown> | Omit<AuditEvent, 'hash'>): string {
    const sorted = { ...entry } as Record<string, unknown>;
    // Sort keys recursively (top-level is sufficient for our schema)
    const keys = Object.keys(sorted).sort();
    const obj: Record<string, unknown> = {};
    for (const k of keys) {
      obj[k] = sorted[k];
    }
    // Date serialization: ISO string
    return JSON.stringify(obj, (_key: string, value: unknown) => {
      if (value instanceof Date) return value.toISOString();
      return value;
    });
  }

  private computeHash(canonical: string): string {
    const data = Buffer.from(canonical, 'utf8');
    const hashBuf = crypto.createHash('sha256').update(data).digest();
    return hashBuf.toString('hex');
  }
}

export class MemoryApprovalRepository implements IApprovalRepository {
  private approvals = new Map<string, ApprovalRecord>();

  async create(data: Omit<ApprovalRecord, 'id' | 'requestedAt'>): Promise<ApprovalRecord> {
    const approval: ApprovalRecord = {
      id: `appr_${randomUUID().replace(/-/g, '')}`,
      ...data,
      requestedAt: new Date(),
    };
    this.approvals.set(approval.id, approval);
    return approval;
  }

  async findById(id: string): Promise<ApprovalRecord | null> {
    return this.approvals.get(id) ?? null;
  }

  async listBySession(sessionId: string): Promise<ApprovalRecord[]> {
    return Array.from(this.approvals.values()).filter((a) => a.sessionId === sessionId);
  }

  async listByUser(userId: string, status?: string): Promise<ApprovalRecord[]> {
    return Array.from(this.approvals.values()).filter((a) => {
      if (a.userId !== userId) return false;
      if (status && a.status !== status) return false;
      return true;
    });
  }

  async listPending(userId: string): Promise<ApprovalRecord[]> {
    return Array.from(this.approvals.values()).filter(
      (a) => a.userId === userId && a.status === 'pending',
    );
  }

  async listAllPending(): Promise<ApprovalRecord[]> {
    return Array.from(this.approvals.values()).filter((approval) => approval.status === 'pending');
  }

  async update(id: string, updates: Partial<ApprovalRecord>): Promise<ApprovalRecord | null> {
    const a = this.approvals.get(id);
    if (!a) return null;
    Object.assign(a, updates);
    return a;
  }
}

export class MemoryPushSubscriptionRepository implements IPushSubscriptionRepository {
  private subscriptions = new Map<string, PushSubscriptionRecord>();

  async upsert(
    data: Omit<PushSubscriptionRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<PushSubscriptionRecord> {
    const target = data.channel === 'web-push' ? data.endpoint : data.fcmToken;
    const existing = Array.from(this.subscriptions.values()).find(
      (item) =>
        item.userId === data.userId &&
        item.channel === data.channel &&
        (item.channel === 'web-push' ? item.endpoint : item.fcmToken) === target,
    );
    const now = new Date();
    const record: PushSubscriptionRecord = {
      ...data,
      id: existing?.id ?? `push_${randomUUID().replace(/-/g, '')}`,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.subscriptions.set(record.id, record);
    return record;
  }

  async listByUser(userId: string): Promise<PushSubscriptionRecord[]> {
    return Array.from(this.subscriptions.values()).filter((item) => item.userId === userId);
  }

  async delete(userId: string, target: string): Promise<boolean> {
    const match = Array.from(this.subscriptions.values()).find(
      (item) => item.userId === userId && (item.endpoint === target || item.fcmToken === target),
    );
    return match ? this.subscriptions.delete(match.id) : false;
  }
}

export class MemoryOrganizationRepository implements IOrganizationRepository {
  private organizations = new Map<string, OrganizationRecord>();
  private memberships = new Map<string, OrganizationMembership>();
  private membershipKey(orgId: string, userId: string): string {
    return `${orgId}:${userId}`;
  }

  async create(
    data: Omit<OrganizationRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<OrganizationRecord> {
    const now = new Date();
    const organization = { ...data, createdAt: now, updatedAt: now };
    this.organizations.set(organization.id, organization);
    await this.addMember({
      organizationId: organization.id,
      userId: organization.ownerId,
      role: 'owner',
    });
    return organization;
  }
  async findById(id: string): Promise<OrganizationRecord | null> {
    return this.organizations.get(id) ?? null;
  }
  async listByUser(userId: string): Promise<OrganizationRecord[]> {
    const ids = [...this.memberships.values()]
      .filter((item) => item.userId === userId)
      .map((item) => item.organizationId);
    return ids
      .map((id) => this.organizations.get(id))
      .filter((item): item is OrganizationRecord => Boolean(item));
  }
  async addMember(
    data: Omit<OrganizationMembership, 'createdAt'>,
  ): Promise<OrganizationMembership> {
    const membership = { ...data, createdAt: new Date() };
    this.memberships.set(this.membershipKey(data.organizationId, data.userId), membership);
    return membership;
  }
  async getMembership(
    organizationId: string,
    userId: string,
  ): Promise<OrganizationMembership | null> {
    return this.memberships.get(this.membershipKey(organizationId, userId)) ?? null;
  }
  async listMembers(organizationId: string): Promise<OrganizationMembership[]> {
    return [...this.memberships.values()].filter((item) => item.organizationId === organizationId);
  }
}

export class MemoryOrchestrationRepository implements IOrchestrationRepository {
  private runs = new Map<string, OrchestrationRun>();
  private decisions: RoutingDecision[] = [];
  private budgets = new Map<string, BudgetLimit>();
  private costs: CostEventRecord[] = [];
  async createRun(run: OrchestrationRun): Promise<OrchestrationRun> {
    this.runs.set(run.id, run);
    return run;
  }
  async findRun(id: string): Promise<OrchestrationRun | null> {
    return this.runs.get(id) ?? null;
  }
  async listRuns(organizationId: string, projectId?: string): Promise<OrchestrationRun[]> {
    return [...this.runs.values()].filter(
      (run) =>
        run.organizationId === organizationId && (!projectId || run.plan.projectId === projectId),
    );
  }
  async updateRun(id: string, update: Partial<OrchestrationRun>): Promise<OrchestrationRun | null> {
    const run = this.runs.get(id);
    if (!run) return null;
    Object.assign(run, update, { updatedAt: new Date() });
    return run;
  }
  async appendRoutingDecision(decision: RoutingDecision): Promise<RoutingDecision> {
    this.decisions.push(decision);
    return decision;
  }
  async listRoutingDecisions(projectId: string, limit = 100): Promise<RoutingDecision[]> {
    return this.decisions.filter((item) => item.request.projectId === projectId).slice(-limit);
  }
  async upsertBudget(budget: BudgetLimit): Promise<BudgetLimit> {
    this.budgets.set(budget.id, budget);
    return budget;
  }
  async listBudgets(scope: BudgetLimit['scope'], scopeId: string): Promise<BudgetLimit[]> {
    return [...this.budgets.values()].filter(
      (item) => item.scope === scope && item.scopeId === scopeId,
    );
  }
  async appendCost(data: Omit<CostEventRecord, 'id' | 'recordedAt'>): Promise<CostEventRecord> {
    const event = { ...data, id: `cost_${randomUUID().replace(/-/g, '')}`, recordedAt: new Date() };
    this.costs.push(event);
    return event;
  }
  async listCosts(options: {
    sessionId?: string;
    projectId?: string;
    organizationId?: string;
  }): Promise<CostEventRecord[]> {
    return this.costs.filter(
      (item) =>
        (!options.sessionId || item.sessionId === options.sessionId) &&
        (!options.projectId || item.projectId === options.projectId) &&
        (!options.organizationId || item.organizationId === options.organizationId),
    );
  }
}

export class MemoryDatabase implements IDatabase {
  public users = new MemoryUserRepository();
  public devices = new MemoryDeviceRepository();
  public pairings = new MemoryPairingRepository();
  public sessions = new MemorySessionRepository();
  public projects = new MemoryProjectRepository();
  public integrationCredentials = new MemoryIntegrationCredentialRepository();
  public organizations = new MemoryOrganizationRepository();
  public orchestration = new MemoryOrchestrationRepository();
  public events = new MemoryEventRepository();
  public approvals = new MemoryApprovalRepository();
  public pushSubscriptions = new MemoryPushSubscriptionRepository();
  public audit = new MemoryAuditRepository();
  public integrationGrants = new MemoryIntegrationGrantRepository();
  public externalConversations = new MemoryExternalConversationRepository();
  public providerUsage = new MemoryProviderUsageRepository();
}

export class MemoryIntegrationGrantRepository implements IIntegrationGrantRepository {
  private readonly records = new Map<string, IntegrationGrantRecord>();

  async upsert(record: Omit<IntegrationGrantRecord, 'updatedAt'>): Promise<IntegrationGrantRecord> {
    const stored: IntegrationGrantRecord = { ...record, updatedAt: new Date() };
    this.records.set(`${record.deviceId}:${record.integration}`, stored);
    return stored;
  }

  async listByDevice(deviceId: string): Promise<IntegrationGrantRecord[]> {
    return [...this.records.values()].filter((record) => record.deviceId === deviceId);
  }

  async find(
    deviceId: string,
    integration: IntegrationGrantRecord['integration'],
  ): Promise<IntegrationGrantRecord | null> {
    return this.records.get(`${deviceId}:${integration}`) ?? null;
  }
}

export class MemoryExternalConversationRepository implements IExternalConversationRepository {
  private readonly records = new Map<string, ExternalConversationRecord>();
  private readonly items = new Map<string, HistoryItem[]>();

  async upsert(record: ExternalConversationRecord): Promise<void> {
    this.records.set(record.id, { ...record });
  }

  async find(id: string): Promise<ExternalConversationRecord | null> {
    return this.records.get(id) ?? null;
  }

  async listByUser(
    userId: string,
    filter: {
      integration?: ExternalConversationRecord['integration'] | undefined;
      deviceId?: string | undefined;
    } = {},
  ): Promise<ExternalConversationRecord[]> {
    return [...this.records.values()].filter(
      (record) =>
        record.userId === userId &&
        (!filter.integration || record.integration === filter.integration) &&
        (!filter.deviceId || record.deviceId === filter.deviceId),
    );
  }

  async listByDeviceIntegration(
    deviceId: string,
    integration: ExternalConversationRecord['integration'],
  ): Promise<ExternalConversationRecord[]> {
    return [...this.records.values()].filter(
      (record) => record.deviceId === deviceId && record.integration === integration,
    );
  }

  async writeItems(id: string, part: number, items: HistoryItem[]): Promise<void> {
    const existing = part === 0 ? [] : (this.items.get(id) ?? []);
    this.items.set(id, [...existing, ...items]);
  }

  async readItems(id: string): Promise<HistoryItem[]> {
    return this.items.get(id) ?? [];
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.records.delete(id);
      this.items.delete(id);
    }
  }
}

export class MemoryProviderUsageRepository implements IProviderUsageRepository {
  private readonly records = new Map<string, ProviderUsageRecord>();

  async upsert(record: ProviderUsageRecord): Promise<void> {
    this.records.set(`${record.deviceId}:${record.integration}`, record);
  }

  async listByUser(userId: string): Promise<ProviderUsageRecord[]> {
    return [...this.records.values()].filter((record) => record.userId === userId);
  }

  async find(
    deviceId: string,
    integration: ProviderUsageRecord['integration'],
  ): Promise<ProviderUsageRecord | null> {
    return this.records.get(`${deviceId}:${integration}`) ?? null;
  }

  async delete(deviceId: string, integration: ProviderUsageRecord['integration']): Promise<void> {
    this.records.delete(`${deviceId}:${integration}`);
  }
}

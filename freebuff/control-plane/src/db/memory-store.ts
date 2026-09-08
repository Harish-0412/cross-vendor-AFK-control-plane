import { randomUUID } from 'node:crypto';
import crypto from 'node:crypto';

import type {
  User,
  DeviceRecord,
  PairingSession,
  SessionRecord,
  ApprovalRecord,
  StoredEvent,
  AuditEvent,
  PushSubscriptionRecord,
} from '../types';

import type {
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
} from './types';

export class MemoryUserRepository implements IUserRepository {
  private users = new Map<string, User>();

  async create(data: Omit<User, 'id' | 'createdAt' | 'updatedAt' | 'passwordHash'> & {
    id?: string;
    passwordHash?: string;
  }): Promise<User> {
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
    const normalized = code.toUpperCase().replace(/\s/g, '');
    for (const p of this.pairings.values()) {
      if (p.code.toUpperCase().replace(/\s/g, '') === normalized) {
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

export class MemoryEventRepository implements IEventRepository {
  private events: StoredEvent[] = [];

  async append(data: Omit<StoredEvent, 'id' | 'storedAt'>): Promise<StoredEvent> {
    const event: StoredEvent = {
      id: `evt_${randomUUID().replace(/-/g, '')}`,
      ...data,
      storedAt: new Date(),
    };
    this.events.push(event);
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

  async append(data: Omit<AuditEvent, 'id' | 'sequence' | 'hash' | 'previousHash'>): Promise<AuditEvent> {
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
      // Recompute: canonicalize without hash field, append previousHash
      const { hash, ...rest } = evt;
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
    return JSON.stringify(obj, (_key, value) => {
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
    const existing = Array.from(this.subscriptions.values()).find((item) =>
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
    const match = Array.from(this.subscriptions.values()).find((item) =>
      item.userId === userId && (item.endpoint === target || item.fcmToken === target),
    );
    return match ? this.subscriptions.delete(match.id) : false;
  }
}

export class MemoryDatabase implements IDatabase {
  public users = new MemoryUserRepository();
  public devices = new MemoryDeviceRepository();
  public pairings = new MemoryPairingRepository();
  public sessions = new MemorySessionRepository();
  public events = new MemoryEventRepository();
  public approvals = new MemoryApprovalRepository();
  public pushSubscriptions = new MemoryPushSubscriptionRepository();
  public audit = new MemoryAuditRepository();
}

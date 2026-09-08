import type {
  User,
  DeviceRecord,
  PairingSession,
  SessionRecord,
  ApprovalRecord,
  StoredEvent,
  PushSubscriptionRecord,
  AuditEvent,
} from '../types';

export interface IUserRepository {
  create(user: Omit<User, 'id' | 'createdAt' | 'updatedAt' | 'passwordHash'> & {
    id?: string;
    passwordHash?: string;
  }): Promise<User>;
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  list(): Promise<User[]>;
  update(id: string, updates: Partial<User>): Promise<User | null>;
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

export interface IEventRepository {
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
  list(
    options?: {
      sessionId?: string;
      deviceId?: string;
      actorType?: string;
      actorId?: string;
      decision?: string;
      fromSequence?: number;
      limit?: number;
    },
  ): Promise<AuditEvent[]>;
  getHighestSequence(): Promise<number>;
  findById(id: string): Promise<AuditEvent | null>;
  verifyChain(): Promise<{ valid: boolean; firstBrokenIndex?: number }> | { valid: boolean; firstBrokenIndex?: number };
}

export interface IDatabase {
  users: IUserRepository;
  devices: IDeviceRepository;
  pairings: IPairingRepository;
  sessions: ISessionRepository;
  events: IEventRepository;
  approvals: IApprovalRepository;
  pushSubscriptions: IPushSubscriptionRepository;
  audit: IAuditRepository;
}

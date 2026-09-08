import type {
  User,
  DeviceRecord,
  PairingSession,
  SessionRecord,
  ApprovalRecord,
  StoredEvent,
} from '../types';

export interface IUserRepository {
  create(user: Omit<User, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<User>;
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  list(): Promise<User[]>;
}

export interface IDeviceRepository {
  create(device: Omit<DeviceRecord, 'createdAt' | 'updatedAt'>): Promise<DeviceRecord>;
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
  create(session: Omit<SessionRecord, 'createdAt' | 'updatedAt'>): Promise<SessionRecord>;
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
  listPending(userId: string): Promise<ApprovalRecord[]>;
  update(id: string, updates: Partial<ApprovalRecord>): Promise<ApprovalRecord | null>;
}

export interface IAuditRepository {
  append(event: Omit<AuditEvent, 'id' | 'sequence' | 'hash'>): Promise<AuditEvent>;
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
}

export interface IDatabase {
  users: IUserRepository;
  devices: IDeviceRepository;
  pairings: IPairingRepository;
  sessions: ISessionRepository;
  events: IEventRepository;  approvals: IApprovalRepository;
  audit: IAuditRepository;
}



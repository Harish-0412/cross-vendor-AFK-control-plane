// freebuff/control-plane/src/db/firestore-store.ts
// Cloud Firestore persistence layer implementing IDatabase

import { randomUUID } from 'node:crypto';
import crypto from 'node:crypto';
import type { Firestore, Timestamp } from 'firebase-admin/firestore';

import type {
  User,
  DeviceRecord,
  PairingSession,
  SessionRecord,
  ApprovalRecord,
  StoredEvent,
  AuditEvent,
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
} from './types';

function toDate(val: unknown): Date {
  if (!val) return new Date();
  if (val instanceof Date) return val;
  if (typeof (val as { toDate?: () => Date }).toDate === 'function') {
    return (val as { toDate: () => Date }).toDate();
  }
  return new Date(val as string | number);
}

function cleanUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const res: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      res[k] = v;
    }
  }
  return res;
}

// -------------------------------------------------------------------------
// User Repository
// -------------------------------------------------------------------------
export class FirestoreUserRepository implements IUserRepository {
  constructor(private db: Firestore) {}
  private col = () => this.db.collection('users');

  async create(data: Omit<User, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<User> {
    const id = data.id || `usr_${randomUUID().replace(/-/g, '')}`;
    const now = new Date();
    const user: User = {
      id,
      ...data,
      createdAt: now,
      updatedAt: now,
    };
    await this.col().doc(id).set(cleanUndefined(user as unknown as Record<string, unknown>));
    return user;
  }

  async findById(id: string): Promise<User | null> {
    const doc = await this.col().doc(id).get();
    if (!doc.exists) return null;
    const data = doc.data()!;
    return {
      ...data,
      id: doc.id,
      createdAt: toDate(data['createdAt']),
      updatedAt: toDate(data['updatedAt']),
    } as User;
  }

  async findByEmail(email: string): Promise<User | null> {
    const snap = await this.col().where('email', '==', email.trim().toLowerCase()).limit(1).get();
    if (snap.empty) {
      // Fallback query without lowercase if needed
      const snapExact = await this.col().where('email', '==', email.trim()).limit(1).get();
      if (snapExact.empty) return null;
      const doc = snapExact.docs[0]!;
      const data = doc.data();
      return {
        ...data,
        id: doc.id,
        createdAt: toDate(data['createdAt']),
        updatedAt: toDate(data['updatedAt']),
      } as User;
    }
    const doc = snap.docs[0]!;
    const data = doc.data();
    return {
      ...data,
      id: doc.id,
      createdAt: toDate(data['createdAt']),
      updatedAt: toDate(data['updatedAt']),
    } as User;
  }

  async list(): Promise<User[]> {
    const snap = await this.col().get();
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        ...data,
        id: d.id,
        createdAt: toDate(data['createdAt']),
        updatedAt: toDate(data['updatedAt']),
      } as User;
    });
  }
}

// -------------------------------------------------------------------------
// Device Repository
// -------------------------------------------------------------------------
export class FirestoreDeviceRepository implements IDeviceRepository {
  constructor(private db: Firestore) {}
  private col = () => this.db.collection('devices');

  async create(data: Omit<DeviceRecord, 'createdAt' | 'updatedAt'>): Promise<DeviceRecord> {
    const now = new Date();
    const device: DeviceRecord = {
      ...data,
      createdAt: now,
      updatedAt: now,
    };
    await this.col().doc(device.id).set(cleanUndefined(device as unknown as Record<string, unknown>));
    return device;
  }

  async findById(id: string): Promise<DeviceRecord | null> {
    const doc = await this.col().doc(id).get();
    if (!doc.exists) return null;
    const d = doc.data()!;
    return {
      ...d,
      id: doc.id,
      createdAt: toDate(d['createdAt']),
      updatedAt: toDate(d['updatedAt']),
      lastSeenAt: d['lastSeenAt'] ? toDate(d['lastSeenAt']) : undefined,
    } as DeviceRecord;
  }

  async findByGatewayId(gatewayId: string): Promise<DeviceRecord | null> {
    const snap = await this.col().where('gatewayId', '==', gatewayId).limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0]!;
    const d = doc.data();
    return {
      ...d,
      id: doc.id,
      createdAt: toDate(d['createdAt']),
      updatedAt: toDate(d['updatedAt']),
      lastSeenAt: d['lastSeenAt'] ? toDate(d['lastSeenAt']) : undefined,
    } as DeviceRecord;
  }

  async listByUser(userId: string): Promise<DeviceRecord[]> {
    const snap = await this.col().where('userId', '==', userId).get();
    return snap.docs.map((doc) => {
      const d = doc.data();
      return {
        ...d,
        id: doc.id,
        createdAt: toDate(d['createdAt']),
        updatedAt: toDate(d['updatedAt']),
        lastSeenAt: d['lastSeenAt'] ? toDate(d['lastSeenAt']) : undefined,
      } as DeviceRecord;
    });
  }

  async update(id: string, updates: Partial<DeviceRecord>): Promise<DeviceRecord | null> {
    const ref = this.col().doc(id);
    const existing = await this.findById(id);
    if (!existing) return null;

    const dataToSave = cleanUndefined({
      ...updates,
      updatedAt: new Date(),
    });
    await ref.set(dataToSave, { merge: true });
    return this.findById(id);
  }

  async updateStatus(id: string, status: DeviceRecord['status']): Promise<DeviceRecord | null> {
    return this.update(id, { status });
  }

  async updateLastSeen(id: string, lastSeenAt: Date = new Date()): Promise<DeviceRecord | null> {
    return this.update(id, { lastSeenAt });
  }

  async updateResourceUsage(
    id: string,
    usage: DeviceRecord['resourceUsage'],
  ): Promise<DeviceRecord | null> {
    return this.update(id, { resourceUsage: usage });
  }

  async delete(id: string): Promise<boolean> {
    const doc = await this.col().doc(id).get();
    if (!doc.exists) return false;
    await this.col().doc(id).delete();
    return true;
  }
}

// -------------------------------------------------------------------------
// Pairing Repository
// -------------------------------------------------------------------------
export class FirestorePairingRepository implements IPairingRepository {
  constructor(private db: Firestore) {}
  private col = () => this.db.collection('pairings');

  async create(data: Omit<PairingSession, 'id' | 'createdAt'>): Promise<PairingSession> {
    const id = `pair_${randomUUID().replace(/-/g, '')}`;
    const pairing: PairingSession = {
      id,
      ...data,
      createdAt: new Date(),
    };
    await this.col().doc(id).set(cleanUndefined(pairing as unknown as Record<string, unknown>));
    return pairing;
  }

  async findById(id: string): Promise<PairingSession | null> {
    const doc = await this.col().doc(id).get();
    if (!doc.exists) return null;
    const d = doc.data()!;
    return {
      ...d,
      id: doc.id,
      createdAt: toDate(d['createdAt']),
      expiresAt: toDate(d['expiresAt']),
    } as PairingSession;
  }

  async findByCode(code: string): Promise<PairingSession | null> {
    const snap = await this.col().where('code', '==', code).limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0]!;
    const d = doc.data();
    return {
      ...d,
      id: doc.id,
      createdAt: toDate(d['createdAt']),
      expiresAt: toDate(d['expiresAt']),
    } as PairingSession;
  }

  async findByDeviceId(deviceId: string): Promise<PairingSession | null> {
    const snap = await this.col().where('deviceId', '==', deviceId).limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0]!;
    const d = doc.data();
    return {
      ...d,
      id: doc.id,
      createdAt: toDate(d['createdAt']),
      expiresAt: toDate(d['expiresAt']),
    } as PairingSession;
  }

  async update(id: string, updates: Partial<PairingSession>): Promise<PairingSession | null> {
    const ref = this.col().doc(id);
    const existing = await this.findById(id);
    if (!existing) return null;

    await ref.set(cleanUndefined(updates as Record<string, unknown>), { merge: true });
    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const doc = await this.col().doc(id).get();
    if (!doc.exists) return false;
    await this.col().doc(id).delete();
    return true;
  }
}

// -------------------------------------------------------------------------
// Session Repository
// -------------------------------------------------------------------------
export class FirestoreSessionRepository implements ISessionRepository {
  constructor(private db: Firestore) {}
  private col = () => this.db.collection('sessions');

  async create(data: Omit<SessionRecord, 'createdAt' | 'updatedAt'>): Promise<SessionRecord> {
    const now = new Date();
    const session: SessionRecord = {
      ...data,
      createdAt: now,
      updatedAt: now,
    };
    await this.col().doc(session.id).set(cleanUndefined(session as unknown as Record<string, unknown>));
    return session;
  }

  async findById(id: string): Promise<SessionRecord | null> {
    const doc = await this.col().doc(id).get();
    if (!doc.exists) return null;
    const d = doc.data()!;
    return {
      ...d,
      id: doc.id,
      createdAt: toDate(d['createdAt']),
      updatedAt: toDate(d['updatedAt']),
    } as SessionRecord;
  }

  async listByUser(
    userId: string,
    filter?: {
      deviceId?: string | undefined;
      state?: string | undefined;
      agentId?: string | undefined;
    },
  ): Promise<SessionRecord[]> {
    let query: FirebaseFirestore.Query = this.col().where('userId', '==', userId);

    if (filter?.deviceId) {
      query = query.where('deviceId', '==', filter.deviceId);
    }
    if (filter?.state) {
      query = query.where('state', '==', filter.state);
    }
    if (filter?.agentId) {
      query = query.where('agentId', '==', filter.agentId);
    }

    const snap = await query.get();
    return snap.docs.map((doc) => {
      const d = doc.data();
      return {
        ...d,
        id: doc.id,
        createdAt: toDate(d['createdAt']),
        updatedAt: toDate(d['updatedAt']),
      } as SessionRecord;
    });
  }

  async listByDevice(deviceId: string): Promise<SessionRecord[]> {
    const snap = await this.col().where('deviceId', '==', deviceId).get();
    return snap.docs.map((doc) => {
      const d = doc.data();
      return {
        ...d,
        id: doc.id,
        createdAt: toDate(d['createdAt']),
        updatedAt: toDate(d['updatedAt']),
      } as SessionRecord;
    });
  }

  async update(id: string, updates: Partial<SessionRecord>): Promise<SessionRecord | null> {
    const ref = this.col().doc(id);
    const existing = await this.findById(id);
    if (!existing) return null;

    const dataToSave = cleanUndefined({
      ...updates,
      updatedAt: new Date(),
    });
    await ref.set(dataToSave, { merge: true });
    return this.findById(id);
  }
}

// -------------------------------------------------------------------------
// Event Repository
// -------------------------------------------------------------------------
export class FirestoreEventRepository implements IEventRepository {
  constructor(private db: Firestore) {}
  private col = () => this.db.collection('events');

  async append(data: Omit<StoredEvent, 'id' | 'storedAt'>): Promise<StoredEvent> {
    const id = `evt_${randomUUID().replace(/-/g, '')}`;
    const storedAt = new Date();
    const event: StoredEvent = {
      id,
      ...data,
      storedAt,
    };
    await this.col().doc(id).set(cleanUndefined(event as unknown as Record<string, unknown>));
    return event;
  }

  async listBySession(sessionId: string, fromSequence = 0, limit = 2000): Promise<StoredEvent[]> {
    const snap = await this.col()
      .where('sessionId', '==', sessionId)
      .where('sequence', '>=', fromSequence)
      .orderBy('sequence', 'asc')
      .limit(limit)
      .get();

    return snap.docs.map((doc) => {
      const d = doc.data();
      return {
        ...d,
        id: doc.id,
        storedAt: toDate(d['storedAt']),
      } as StoredEvent;
    });
  }

  async getHighestSequence(sessionId: string): Promise<number> {
    const snap = await this.col()
      .where('sessionId', '==', sessionId)
      .orderBy('sequence', 'desc')
      .limit(1)
      .get();

    if (snap.empty) return 0;
    return (snap.docs[0]!.data()['sequence'] as number) || 0;
  }
}

// -------------------------------------------------------------------------
// Approval Repository
// -------------------------------------------------------------------------
export class FirestoreApprovalRepository implements IApprovalRepository {
  constructor(private db: Firestore) {}
  private col = () => this.db.collection('approvals');

  async create(data: Omit<ApprovalRecord, 'id' | 'requestedAt'>): Promise<ApprovalRecord> {
    const id = `appr_${randomUUID().replace(/-/g, '')}`;
    const approval: ApprovalRecord = {
      id,
      ...data,
      requestedAt: new Date(),
    };
    await this.col().doc(id).set(cleanUndefined(approval as unknown as Record<string, unknown>));
    return approval;
  }

  async findById(id: string): Promise<ApprovalRecord | null> {
    const doc = await this.col().doc(id).get();
    if (!doc.exists) return null;
    const d = doc.data()!;
    return {
      ...d,
      id: doc.id,
      requestedAt: toDate(d['requestedAt']),
      respondedAt: d['respondedAt'] ? toDate(d['respondedAt']) : undefined,
    } as ApprovalRecord;
  }

  async listBySession(sessionId: string): Promise<ApprovalRecord[]> {
    const snap = await this.col().where('sessionId', '==', sessionId).get();
    return snap.docs.map((doc) => {
      const d = doc.data();
      return {
        ...d,
        id: doc.id,
        requestedAt: toDate(d['requestedAt']),
        respondedAt: d['respondedAt'] ? toDate(d['respondedAt']) : undefined,
      } as ApprovalRecord;
    });
  }

  async listPending(userId: string): Promise<ApprovalRecord[]> {
    const snap = await this.col()
      .where('userId', '==', userId)
      .where('status', '==', 'pending')
      .get();

    return snap.docs.map((doc) => {
      const d = doc.data();
      return {
        ...d,
        id: doc.id,
        requestedAt: toDate(d['requestedAt']),
        respondedAt: d['respondedAt'] ? toDate(d['respondedAt']) : undefined,
      } as ApprovalRecord;
    });
  }

  async update(id: string, updates: Partial<ApprovalRecord>): Promise<ApprovalRecord | null> {
    const ref = this.col().doc(id);
    const existing = await this.findById(id);
    if (!existing) return null;

    await ref.set(cleanUndefined(updates as Record<string, unknown>), { merge: true });
    return this.findById(id);
  }
}

// -------------------------------------------------------------------------
// Audit Repository
// -------------------------------------------------------------------------
export class FirestoreAuditRepository implements IAuditRepository {
  constructor(private db: Firestore) {}
  private col = () => this.db.collection('audit');

  async append(data: Omit<AuditEvent, 'id' | 'sequence' | 'hash'>): Promise<AuditEvent> {
    const id = `aud_${randomUUID().replace(/-/g, '')}`;
    const sequence = (await this.getHighestSequence()) + 1;
    const timestamp = data.timestamp || new Date();

    const payloadToHash = JSON.stringify({
      sequence,
      timestamp: timestamp.toISOString(),
      eventType: data.eventType,
      actorType: data.actorType,
      actorId: data.actorId,
      action: data.action,
      details: data.details,
    });
    const hash = crypto.createHash('sha256').update(payloadToHash).digest('hex');

    const entry: AuditEvent = {
      id,
      sequence,
      hash,
      ...data,
      timestamp,
    };

    await this.col().doc(id).set(cleanUndefined(entry as unknown as Record<string, unknown>));
    return entry;
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
    let query: FirebaseFirestore.Query = this.col();

    if (options?.sessionId) query = query.where('sessionId', '==', options.sessionId);
    if (options?.deviceId) query = query.where('deviceId', '==', options.deviceId);
    if (options?.actorType) query = query.where('actorType', '==', options.actorType);
    if (options?.actorId) query = query.where('actorId', '==', options.actorId);
    if (options?.decision) query = query.where('decision', '==', options.decision);
    if (options?.fromSequence) query = query.where('sequence', '>=', options.fromSequence);

    query = query.orderBy('sequence', 'asc').limit(options?.limit || 100);

    const snap = await query.get();
    return snap.docs.map((doc) => {
      const d = doc.data();
      return {
        ...d,
        id: doc.id,
        timestamp: toDate(d['timestamp']),
      } as AuditEvent;
    });
  }

  async getHighestSequence(): Promise<number> {
    const snap = await this.col().orderBy('sequence', 'desc').limit(1).get();
    if (snap.empty) return 0;
    return (snap.docs[0]!.data()['sequence'] as number) || 0;
  }

  async findById(id: string): Promise<AuditEvent | null> {
    const doc = await this.col().doc(id).get();
    if (!doc.exists) return null;
    const d = doc.data()!;
    return {
      ...d,
      id: doc.id,
      timestamp: toDate(d['timestamp']),
    } as AuditEvent;
  }
}

// -------------------------------------------------------------------------
// Unified Firestore Database
// -------------------------------------------------------------------------
export class FirestoreDatabase implements IDatabase {
  public users: IUserRepository;
  public devices: IDeviceRepository;
  public pairings: IPairingRepository;
  public sessions: ISessionRepository;
  public events: IEventRepository;
  public approvals: IApprovalRepository;
  public audit: IAuditRepository;

  constructor(private firestore: Firestore) {
    this.users = new FirestoreUserRepository(this.firestore);
    this.devices = new FirestoreDeviceRepository(this.firestore);
    this.pairings = new FirestorePairingRepository(this.firestore);
    this.sessions = new FirestoreSessionRepository(this.firestore);
    this.events = new FirestoreEventRepository(this.firestore);
    this.approvals = new FirestoreApprovalRepository(this.firestore);
    this.audit = new FirestoreAuditRepository(this.firestore);
  }
}

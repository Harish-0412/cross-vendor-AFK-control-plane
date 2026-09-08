// freebuff/control-plane/src/db/firestore-store.ts
// Cloud Firestore persistence layer implementing IDatabase

import crypto, { randomUUID } from 'node:crypto';

import type { Firestore } from 'firebase-admin/firestore';

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
  IProjectRepository,
  IIntegrationCredentialRepository,
} from './types';

/**
 * `DocumentSnapshot.data()` is typed as `DocumentData | undefined`, where
 * `DocumentData = { [field: string]: any }` — every spread of that value
 * (`{...d, ...}`, used throughout this file to merge Firestore's raw fields
 * with normalized ones like `createdAt`/`updatedAt`) silently produced an
 * `any`-typed object, which is why this file had 6+ `no-unsafe-assignment`
 * lint errors despite every individual field access looking reasonable. One
 * narrowing point here means every call site spreads a `Record<string,
 * unknown>` instead.
 */
function docData(doc: { data(): Record<string, unknown> | undefined }): Record<string, unknown> {
  return doc.data() ?? {};
}

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

  async create(
    data: Omit<User, 'id' | 'createdAt' | 'updatedAt' | 'passwordHash'> & {
      id?: string;
      passwordHash?: string;
    },
  ): Promise<User> {
    const id = data.id || `usr_${randomUUID().replace(/-/g, '')}`;
    const now = new Date();
    const user: User = {
      id,
      ...data,
      passwordHash: data.passwordHash ?? '',
      createdAt: now,
      updatedAt: now,
    };
    await this.col()
      .doc(id)
      .set(cleanUndefined(user as unknown as Record<string, unknown>));
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

  async update(id: string, updates: Partial<User>): Promise<User | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    await this.col()
      .doc(id)
      .set(cleanUndefined({ ...updates, updatedAt: new Date() }), {
        merge: true,
      });
    return this.findById(id);
  }
}

// -------------------------------------------------------------------------
// Device Repository
// -------------------------------------------------------------------------
export class FirestoreDeviceRepository implements IDeviceRepository {
  constructor(private db: Firestore) {}
  private col = () => this.db.collection('devices');

  async create(data: CreateDeviceRecord): Promise<DeviceRecord> {
    const now = new Date();
    const device: DeviceRecord = {
      ...data,
      defaultTrustProfile: data.defaultTrustProfile ?? 'default',
      createdAt: now,
      updatedAt: now,
    };
    await this.col()
      .doc(device.id)
      .set(cleanUndefined(device as unknown as Record<string, unknown>));
    return device;
  }

  async findById(id: string): Promise<DeviceRecord | null> {
    const doc = await this.col().doc(id).get();
    if (!doc.exists) return null;
    const d = docData(doc);
    return {
      ...d,
      id: doc.id,
      createdAt: toDate(d['createdAt']),
      updatedAt: toDate(d['updatedAt']),
      lastSeenAt: d['lastSeenAt'] ? toDate(d['lastSeenAt']) : undefined,
      defaultTrustProfile: d['defaultTrustProfile'] ?? 'default',
    } as DeviceRecord;
  }

  async findByGatewayId(gatewayId: string): Promise<DeviceRecord | null> {
    const snap = await this.col().where('gatewayId', '==', gatewayId).limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0]!;
    const d = docData(doc);
    return {
      ...d,
      id: doc.id,
      createdAt: toDate(d['createdAt']),
      updatedAt: toDate(d['updatedAt']),
      lastSeenAt: d['lastSeenAt'] ? toDate(d['lastSeenAt']) : undefined,
      defaultTrustProfile: d['defaultTrustProfile'] ?? 'default',
    } as DeviceRecord;
  }

  async listByUser(userId: string): Promise<DeviceRecord[]> {
    const snap = await this.col().where('userId', '==', userId).get();
    return snap.docs.map((doc) => {
      const d = docData(doc);
      return {
        ...d,
        id: doc.id,
        createdAt: toDate(d['createdAt']),
        updatedAt: toDate(d['updatedAt']),
        lastSeenAt: d['lastSeenAt'] ? toDate(d['lastSeenAt']) : undefined,
        defaultTrustProfile: d['defaultTrustProfile'] ?? 'default',
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
    await this.col()
      .doc(id)
      .set(cleanUndefined(pairing as unknown as Record<string, unknown>));
    return pairing;
  }

  async findById(id: string): Promise<PairingSession | null> {
    const doc = await this.col().doc(id).get();
    if (!doc.exists) return null;
    const d = docData(doc);
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
    const d = docData(doc);
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
    const d = docData(doc);
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

  async create(data: CreateSessionRecord): Promise<SessionRecord> {
    const now = new Date();
    const session: SessionRecord = {
      ...data,
      trustProfile: data.trustProfile ?? 'default',
      createdAt: now,
      updatedAt: now,
    };
    await this.col()
      .doc(session.id)
      .set(cleanUndefined(session as unknown as Record<string, unknown>));
    return session;
  }

  async findById(id: string): Promise<SessionRecord | null> {
    const doc = await this.col().doc(id).get();
    if (!doc.exists) return null;
    const d = docData(doc);
    return {
      ...d,
      id: doc.id,
      createdAt: toDate(d['createdAt']),
      updatedAt: toDate(d['updatedAt']),
      trustProfile: d['trustProfile'] ?? 'default',
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
      const d = docData(doc);
      return {
        ...d,
        id: doc.id,
        createdAt: toDate(d['createdAt']),
        updatedAt: toDate(d['updatedAt']),
        trustProfile: d['trustProfile'] ?? 'default',
      } as SessionRecord;
    });
  }

  async listByDevice(deviceId: string): Promise<SessionRecord[]> {
    const snap = await this.col().where('deviceId', '==', deviceId).get();
    return snap.docs.map((doc) => {
      const d = docData(doc);
      return {
        ...d,
        id: doc.id,
        createdAt: toDate(d['createdAt']),
        updatedAt: toDate(d['updatedAt']),
        trustProfile: d['trustProfile'] ?? 'default',
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

export class FirestoreProjectRepository implements IProjectRepository {
  constructor(private db: Firestore) {}
  private col = () => this.db.collection('projects');

  async create(data: Omit<ProjectRecord, 'createdAt' | 'updatedAt'>): Promise<ProjectRecord> {
    const now = new Date();
    const project = { ...data, createdAt: now, updatedAt: now };
    await this.col()
      .doc(project.id)
      .set(cleanUndefined(project as unknown as Record<string, unknown>));
    return project;
  }
  async findById(id: string): Promise<ProjectRecord | null> {
    const doc = await this.col().doc(id).get();
    if (!doc.exists) return null;
    const data = doc.data()!;
    return {
      ...data,
      id: doc.id,
      createdAt: toDate(data['createdAt']),
      updatedAt: toDate(data['updatedAt']),
    } as ProjectRecord;
  }
  async findByRoot(userId: string, root: string): Promise<ProjectRecord | null> {
    const snap = await this.col()
      .where('userId', '==', userId)
      .where('root', '==', root)
      .limit(1)
      .get();
    return snap.empty ? null : this.findById(snap.docs[0]!.id);
  }
  async listByUser(userId: string): Promise<ProjectRecord[]> {
    const snap = await this.col().where('userId', '==', userId).get();
    return Promise.all(snap.docs.map((doc) => this.findById(doc.id))).then((items) =>
      items.filter((item): item is ProjectRecord => item !== null),
    );
  }
  async update(id: string, updates: Partial<ProjectRecord>): Promise<ProjectRecord | null> {
    if (!(await this.findById(id))) return null;
    await this.col()
      .doc(id)
      .set(cleanUndefined({ ...updates, updatedAt: new Date() } as Record<string, unknown>), {
        merge: true,
      });
    return this.findById(id);
  }
}

export class FirestoreIntegrationCredentialRepository implements IIntegrationCredentialRepository {
  constructor(private db: Firestore) {}
  private col = () => this.db.collection('integrationCredentials');
  private id(userId: string, provider: string): string {
    return `${provider}_${userId}`;
  }
  async upsert(
    data: Omit<IntegrationCredentialRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IntegrationCredentialRecord> {
    const id = this.id(data.userId, data.provider);
    const existing = await this.find(data.userId, data.provider);
    const now = new Date();
    const record = { ...data, id, createdAt: existing?.createdAt ?? now, updatedAt: now };
    await this.col().doc(id).set(record);
    return record;
  }
  async find(
    userId: string,
    provider: IntegrationCredentialRecord['provider'],
  ): Promise<IntegrationCredentialRecord | null> {
    const doc = await this.col().doc(this.id(userId, provider)).get();
    if (!doc.exists) return null;
    const data = doc.data()!;
    return {
      ...data,
      id: doc.id,
      createdAt: toDate(data['createdAt']),
      updatedAt: toDate(data['updatedAt']),
    } as IntegrationCredentialRecord;
  }
  async delete(
    userId: string,
    provider: IntegrationCredentialRecord['provider'],
  ): Promise<boolean> {
    const record = await this.find(userId, provider);
    if (!record) return false;
    await this.col().doc(record.id).delete();
    return true;
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
    await this.col()
      .doc(id)
      .set(cleanUndefined(event as unknown as Record<string, unknown>));
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
      const d = docData(doc);
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
    await this.col()
      .doc(id)
      .set(cleanUndefined(approval as unknown as Record<string, unknown>));
    return approval;
  }

  async findById(id: string): Promise<ApprovalRecord | null> {
    const doc = await this.col().doc(id).get();
    if (!doc.exists) return null;
    const d = docData(doc);
    return {
      ...d,
      id: doc.id,
      requestedAt: toDate(d['requestedAt']),
      decidedAt: d['decidedAt'] ? toDate(d['decidedAt']) : undefined,
      reminderSentAt: d['reminderSentAt'] ? toDate(d['reminderSentAt']) : undefined,
      fallbackTriggeredAt: d['fallbackTriggeredAt'] ? toDate(d['fallbackTriggeredAt']) : undefined,
    } as unknown as ApprovalRecord;
  }

  async listBySession(sessionId: string): Promise<ApprovalRecord[]> {
    const snap = await this.col().where('sessionId', '==', sessionId).get();
    return snap.docs.map((doc) => {
      const d = docData(doc);
      return {
        ...d,
        id: doc.id,
        requestedAt: toDate(d['requestedAt']),
        decidedAt: d['decidedAt'] ? toDate(d['decidedAt']) : undefined,
        reminderSentAt: d['reminderSentAt'] ? toDate(d['reminderSentAt']) : undefined,
        fallbackTriggeredAt: d['fallbackTriggeredAt']
          ? toDate(d['fallbackTriggeredAt'])
          : undefined,
      } as unknown as ApprovalRecord;
    });
  }

  async listByUser(userId: string, status?: string): Promise<ApprovalRecord[]> {
    let query: FirebaseFirestore.Query = this.col().where('userId', '==', userId);
    if (status) {
      query = query.where('status', '==', status);
    }

    const snap = await query.orderBy('requestedAt', 'desc').limit(500).get();

    return snap.docs.map((doc) => {
      const d = docData(doc);
      return {
        ...d,
        id: doc.id,
        requestedAt: toDate(d['requestedAt']),
        decidedAt: d['decidedAt'] ? toDate(d['decidedAt']) : undefined,
        reminderSentAt: d['reminderSentAt'] ? toDate(d['reminderSentAt']) : undefined,
        fallbackTriggeredAt: d['fallbackTriggeredAt']
          ? toDate(d['fallbackTriggeredAt'])
          : undefined,
      } as unknown as ApprovalRecord;
    });
  }

  async listPending(userId: string): Promise<ApprovalRecord[]> {
    const snap = await this.col()
      .where('userId', '==', userId)
      .where('status', '==', 'pending')
      .get();

    return snap.docs.map((doc) => {
      const d = docData(doc);
      return {
        ...d,
        id: doc.id,
        requestedAt: toDate(d['requestedAt']),
        decidedAt: d['decidedAt'] ? toDate(d['decidedAt']) : undefined,
        reminderSentAt: d['reminderSentAt'] ? toDate(d['reminderSentAt']) : undefined,
        fallbackTriggeredAt: d['fallbackTriggeredAt']
          ? toDate(d['fallbackTriggeredAt'])
          : undefined,
      } as unknown as ApprovalRecord;
    });
  }

  async listAllPending(): Promise<ApprovalRecord[]> {
    const snap = await this.col().where('status', '==', 'pending').get();
    return snap.docs.map((doc) => {
      const d = docData(doc);
      return {
        ...d,
        id: doc.id,
        requestedAt: toDate(d['requestedAt']),
        decidedAt: d['decidedAt'] ? toDate(d['decidedAt']) : undefined,
        reminderSentAt: d['reminderSentAt'] ? toDate(d['reminderSentAt']) : undefined,
        fallbackTriggeredAt: d['fallbackTriggeredAt']
          ? toDate(d['fallbackTriggeredAt'])
          : undefined,
      } as unknown as ApprovalRecord;
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
// Push Subscription Repository
// -------------------------------------------------------------------------
export class FirestorePushSubscriptionRepository implements IPushSubscriptionRepository {
  constructor(private db: Firestore) {}
  private col = () => this.db.collection('pushSubscriptions');

  async upsert(
    data: Omit<PushSubscriptionRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<PushSubscriptionRecord> {
    const target = data.channel === 'web-push' ? data.endpoint : data.fcmToken;
    const field = data.channel === 'web-push' ? 'endpoint' : 'fcmToken';
    const snap = await this.col()
      .where('userId', '==', data.userId)
      .where(field, '==', target)
      .limit(1)
      .get();
    const now = new Date();
    const existing = snap.empty ? undefined : snap.docs[0];
    const id = existing?.id ?? `push_${randomUUID().replace(/-/g, '')}`;
    const record: PushSubscriptionRecord = {
      ...data,
      id,
      createdAt: existing ? toDate(existing.data()['createdAt']) : now,
      updatedAt: now,
    };
    await this.col()
      .doc(id)
      .set(cleanUndefined(record as unknown as Record<string, unknown>));
    return record;
  }

  async listByUser(userId: string): Promise<PushSubscriptionRecord[]> {
    const snap = await this.col().where('userId', '==', userId).get();
    return snap.docs.map((doc) => {
      const data = doc.data();
      return {
        ...data,
        id: doc.id,
        createdAt: toDate(data['createdAt']),
        updatedAt: toDate(data['updatedAt']),
      } as PushSubscriptionRecord;
    });
  }

  async delete(userId: string, target: string): Promise<boolean> {
    const subscriptions = await this.listByUser(userId);
    const record = subscriptions.find(
      (item) => item.endpoint === target || item.fcmToken === target,
    );
    if (!record) return false;
    await this.col().doc(record.id).delete();
    return true;
  }
}

// -------------------------------------------------------------------------
// Audit Repository
// -------------------------------------------------------------------------
export class FirestoreAuditRepository implements IAuditRepository {
  constructor(private db: Firestore) {}
  private col = () => this.db.collection('audit');

  async append(
    data: Omit<AuditEvent, 'id' | 'sequence' | 'hash' | 'previousHash'>,
  ): Promise<AuditEvent> {
    const id = `aud_${randomUUID().replace(/-/g, '')}`;
    const sequence = (await this.getHighestSequence()) + 1;
    const timestamp = data.timestamp || new Date();

    const previousSnap = await this.col().orderBy('sequence', 'desc').limit(1).get();
    const previousHash = previousSnap.empty
      ? '0'.repeat(64)
      : String(previousSnap.docs[0]!.data()['hash']);
    const payloadToHash = JSON.stringify(
      { ...data, previousHash, sequence },
      (_key: string, value: unknown) => (value instanceof Date ? value.toISOString() : value),
    );
    const hash = crypto.createHash('sha256').update(payloadToHash).digest('hex');

    const entry: AuditEvent = {
      id,
      sequence,
      hash,
      previousHash,
      ...data,
      timestamp,
    };

    await this.col()
      .doc(id)
      .set(cleanUndefined(entry as unknown as Record<string, unknown>));
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
      const d = docData(doc);
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
    const d = docData(doc);
    return {
      ...d,
      id: doc.id,
      timestamp: toDate(d['timestamp']),
    } as AuditEvent;
  }

  async verifyChain(): Promise<{ valid: boolean; firstBrokenIndex?: number }> {
    const events = await this.list({ limit: 10_000 });
    for (let index = 0; index < events.length; index++) {
      const event = events[index]!;
      const expected = index === 0 ? '0'.repeat(64) : events[index - 1]!.hash;
      if (event.previousHash !== expected) return { valid: false, firstBrokenIndex: index };
    }
    return { valid: true };
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
  public projects: IProjectRepository;
  public integrationCredentials: IIntegrationCredentialRepository;
  public events: IEventRepository;
  public approvals: IApprovalRepository;
  public pushSubscriptions: IPushSubscriptionRepository;
  public audit: IAuditRepository;

  constructor(private firestore: Firestore) {
    this.users = new FirestoreUserRepository(this.firestore);
    this.devices = new FirestoreDeviceRepository(this.firestore);
    this.pairings = new FirestorePairingRepository(this.firestore);
    this.sessions = new FirestoreSessionRepository(this.firestore);
    this.projects = new FirestoreProjectRepository(this.firestore);
    this.integrationCredentials = new FirestoreIntegrationCredentialRepository(this.firestore);
    this.events = new FirestoreEventRepository(this.firestore);
    this.approvals = new FirestoreApprovalRepository(this.firestore);
    this.pushSubscriptions = new FirestorePushSubscriptionRepository(this.firestore);
    this.audit = new FirestoreAuditRepository(this.firestore);
  }
}

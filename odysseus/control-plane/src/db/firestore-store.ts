// odysseus/control-plane/src/db/firestore-store.ts
// Cloud Firestore persistence layer implementing IDatabase

import crypto, { randomUUID } from 'node:crypto';

import type {
  BudgetLimit,
  HistoryItem,
  OrchestrationRun,
  RoutingDecision,
} from '@odysseus/protocol';
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

function cleanUndefined<T>(obj: T): T {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return obj;
  }
  if (obj instanceof Date) {
    return obj;
  }
  if (Array.isArray(obj)) {
    return (obj as unknown[])
      .filter((item) => item !== undefined)
      .map((item) => cleanUndefined(item)) as unknown as T;
  }
  const res: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v !== undefined) {
      res[k] = cleanUndefined(v);
    }
  }
  return res as T;
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

  async delete(id: string): Promise<boolean> {
    await this.col().doc(id).delete();
    return true;
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
      .set(
        cleanUndefined({
          ...(pairing as unknown as Record<string, unknown>),
          // Queryable canonical form; the display code is kept as-is.
          codeNormalized: normalizePairingCode(pairing.code),
        }),
      );
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
    // Firestore cannot normalise inside a query, so a canonical `codeNormalized`
    // field is written alongside the display code and queried here. The raw
    // code is still tried as a fallback for sessions written before that field
    // existed.
    const normalized = normalizePairingCode(code);
    let snap = await this.col().where('codeNormalized', '==', normalized).limit(1).get();
    if (snap.empty) {
      snap = await this.col().where('code', '==', code).limit(1).get();
    }
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
    // Idempotency comes from the document id: deriving it from the envelope's
    // eventId makes a redelivery address the same document, so a duplicate is
    // a no-op write rather than a second row. See IEventRepository.append.
    const eventId = data.envelope?.eventId;
    const id = eventId
      ? `evt_${eventId.replace(/[^A-Za-z0-9_-]/g, '')}`
      : `evt_${randomUUID().replace(/-/g, '')}`;

    const docRef = this.col().doc(id);
    if (eventId) {
      const existing = await docRef.get();
      if (existing.exists) {
        const d = docData(existing);
        return {
          ...d,
          id: existing.id,
          storedAt: toDate(d['storedAt']),
        } as StoredEvent;
      }
    }

    const storedAt = new Date();
    const event: StoredEvent = {
      id,
      ...data,
      storedAt,
    };
    await docRef.set(cleanUndefined(event as unknown as Record<string, unknown>));
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
    // Filtering by user + status and ordering by requestedAt requires a
    // deployment-specific composite Firestore index. A missing index turned
    // the dashboard's GET /api/v1/approvals into an HTTP 500. Keep the remote
    // query on the single indexed ownership field, then apply the small
    // bounded status/sort operation in memory. The route is capped at 500
    // records, so this remains predictable while working on every deployment.
    const snap = await this.col().where('userId', '==', userId).limit(500).get();

    return snap.docs
      .map((doc) => {
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
      })
      .filter((approval) => !status || approval.status === status)
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
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
export class FirestoreOrganizationRepository implements IOrganizationRepository {
  constructor(private db: Firestore) {}
  private orgs = () => this.db.collection('organizations');
  private members = () => this.db.collection('organizationMembers');
  private memberId(orgId: string, userId: string): string {
    return `${orgId}_${userId}`;
  }
  async create(
    data: Omit<OrganizationRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<OrganizationRecord> {
    const now = new Date();
    const organization = { ...data, createdAt: now, updatedAt: now };
    await this.orgs().doc(organization.id).set(organization);
    await this.addMember({
      organizationId: organization.id,
      userId: organization.ownerId,
      role: 'owner',
    });
    return organization;
  }
  async findById(id: string): Promise<OrganizationRecord | null> {
    const doc = await this.orgs().doc(id).get();
    if (!doc.exists) return null;
    const data = docData(doc);
    return {
      ...data,
      id: doc.id,
      createdAt: toDate(data['createdAt']),
      updatedAt: toDate(data['updatedAt']),
    } as OrganizationRecord;
  }
  async listByUser(userId: string): Promise<OrganizationRecord[]> {
    const memberships = await this.members().where('userId', '==', userId).get();
    const records = await Promise.all(
      memberships.docs.map((doc) => this.findById(String(doc.data()['organizationId']))),
    );
    return records.filter((item): item is OrganizationRecord => item !== null);
  }
  async addMember(
    data: Omit<OrganizationMembership, 'createdAt'>,
  ): Promise<OrganizationMembership> {
    const membership = { ...data, createdAt: new Date() };
    await this.members().doc(this.memberId(data.organizationId, data.userId)).set(membership);
    return membership;
  }
  async getMembership(
    organizationId: string,
    userId: string,
  ): Promise<OrganizationMembership | null> {
    const doc = await this.members().doc(this.memberId(organizationId, userId)).get();
    if (!doc.exists) return null;
    const data = docData(doc);
    return { ...data, createdAt: toDate(data['createdAt']) } as OrganizationMembership;
  }
  async listMembers(organizationId: string): Promise<OrganizationMembership[]> {
    const result = await this.members().where('organizationId', '==', organizationId).get();
    return result.docs.map((doc) => {
      const data = docData(doc);
      return { ...data, createdAt: toDate(data['createdAt']) } as OrganizationMembership;
    });
  }
}

export class FirestoreOrchestrationRepository implements IOrchestrationRepository {
  constructor(private db: Firestore) {}
  private runs = () => this.db.collection('orchestrationRuns');
  private decisions = () => this.db.collection('routingDecisions');
  private budgets = () => this.db.collection('budgets');
  private costs = () => this.db.collection('costEvents');
  async createRun(run: OrchestrationRun): Promise<OrchestrationRun> {
    await this.runs().doc(run.id).set(run);
    return run;
  }
  async findRun(id: string): Promise<OrchestrationRun | null> {
    const doc = await this.runs().doc(id).get();
    if (!doc.exists) return null;
    return docData(doc) as unknown as OrchestrationRun;
  }
  async listRuns(organizationId: string, projectId?: string): Promise<OrchestrationRun[]> {
    const snap = await this.runs().where('organizationId', '==', organizationId).get();
    return snap.docs
      .map((doc) => docData(doc) as unknown as OrchestrationRun)
      .filter((run) => !projectId || run.plan.projectId === projectId);
  }
  async updateRun(id: string, update: Partial<OrchestrationRun>): Promise<OrchestrationRun | null> {
    await this.runs()
      .doc(id)
      .set({ ...update, updatedAt: new Date() }, { merge: true });
    return this.findRun(id);
  }
  async appendRoutingDecision(decision: RoutingDecision): Promise<RoutingDecision> {
    await this.decisions().doc(decision.id).set(decision);
    return decision;
  }
  async listRoutingDecisions(projectId: string, limit = 100): Promise<RoutingDecision[]> {
    const snap = await this.decisions()
      .where('request.projectId', '==', projectId)
      .limit(limit)
      .get();
    return snap.docs.map((doc) => docData(doc) as unknown as RoutingDecision);
  }
  async upsertBudget(budget: BudgetLimit): Promise<BudgetLimit> {
    await this.budgets().doc(budget.id).set(budget);
    return budget;
  }
  async listBudgets(scope: BudgetLimit['scope'], scopeId: string): Promise<BudgetLimit[]> {
    const snap = await this.budgets()
      .where('scope', '==', scope)
      .where('scopeId', '==', scopeId)
      .get();
    return snap.docs.map((doc) => docData(doc) as unknown as BudgetLimit);
  }
  async appendCost(data: Omit<CostEventRecord, 'id' | 'recordedAt'>): Promise<CostEventRecord> {
    const event = { ...data, id: `cost_${randomUUID().replace(/-/g, '')}`, recordedAt: new Date() };
    await this.costs().doc(event.id).set(event);
    return event;
  }
  async listCosts(options: {
    sessionId?: string;
    projectId?: string;
    organizationId?: string;
  }): Promise<CostEventRecord[]> {
    const snap = await this.costs().get();
    return snap.docs
      .map((doc) => docData(doc) as unknown as CostEventRecord)
      .filter(
        (item) =>
          (!options.sessionId || item.sessionId === options.sessionId) &&
          (!options.projectId || item.projectId === options.projectId) &&
          (!options.organizationId || item.organizationId === options.organizationId),
      );
  }
}

export class FirestoreDatabase implements IDatabase {
  public users: IUserRepository;
  public devices: IDeviceRepository;
  public pairings: IPairingRepository;
  public sessions: ISessionRepository;
  public projects: IProjectRepository;
  public integrationCredentials: IIntegrationCredentialRepository;
  public organizations: IOrganizationRepository;
  public orchestration: IOrchestrationRepository;
  public events: IEventRepository;
  public approvals: IApprovalRepository;
  public pushSubscriptions: IPushSubscriptionRepository;
  public audit: IAuditRepository;
  public integrationGrants: IIntegrationGrantRepository;
  public externalConversations: IExternalConversationRepository;
  public providerUsage: IProviderUsageRepository;

  constructor(private firestore: Firestore) {
    this.users = new FirestoreUserRepository(this.firestore);
    this.devices = new FirestoreDeviceRepository(this.firestore);
    this.pairings = new FirestorePairingRepository(this.firestore);
    this.sessions = new FirestoreSessionRepository(this.firestore);
    this.projects = new FirestoreProjectRepository(this.firestore);
    this.integrationCredentials = new FirestoreIntegrationCredentialRepository(this.firestore);
    this.organizations = new FirestoreOrganizationRepository(this.firestore);
    this.orchestration = new FirestoreOrchestrationRepository(this.firestore);
    this.integrationGrants = new FirestoreIntegrationGrantRepository(this.firestore);
    this.externalConversations = new FirestoreExternalConversationRepository(this.firestore);
    this.providerUsage = new FirestoreProviderUsageRepository(this.firestore);
    this.events = new FirestoreEventRepository(this.firestore);
    this.approvals = new FirestoreApprovalRepository(this.firestore);
    this.pushSubscriptions = new FirestorePushSubscriptionRepository(this.firestore);
    this.audit = new FirestoreAuditRepository(this.firestore);
  }
}

export class FirestoreIntegrationGrantRepository implements IIntegrationGrantRepository {
  constructor(private db: Firestore) {}
  private col = () => this.db.collection('integration_grants');

  private static docId(deviceId: string, integration: string): string {
    return `${deviceId}__${integration}`;
  }

  async upsert(record: Omit<IntegrationGrantRecord, 'updatedAt'>): Promise<IntegrationGrantRecord> {
    const stored: IntegrationGrantRecord = { ...record, updatedAt: new Date() };
    await this.col()
      .doc(FirestoreIntegrationGrantRepository.docId(record.deviceId, record.integration))
      .set(cleanUndefined(stored as unknown as Record<string, unknown>));
    return stored;
  }

  async listByDevice(deviceId: string): Promise<IntegrationGrantRecord[]> {
    const snap = await this.col().where('deviceId', '==', deviceId).get();
    return snap.docs.map((doc) => {
      const data = doc.data();
      return { ...data, updatedAt: toDate(data['updatedAt']) } as IntegrationGrantRecord;
    });
  }

  async find(
    deviceId: string,
    integration: IntegrationGrantRecord['integration'],
  ): Promise<IntegrationGrantRecord | null> {
    const doc = await this.col()
      .doc(FirestoreIntegrationGrantRepository.docId(deviceId, integration))
      .get();
    if (!doc.exists) return null;
    const data = doc.data()!;
    return { ...data, updatedAt: toDate(data['updatedAt']) } as IntegrationGrantRecord;
  }
}

/**
 * Conversation content is stored in chunk documents of at most
 * `ITEMS_PER_CHUNK` items. A Firestore document is capped at 1 MiB and one
 * item can carry up to 4,000 characters, so chunks keep every write well
 * under the limit.
 */
const ITEMS_PER_CHUNK = 100;

export class FirestoreExternalConversationRepository implements IExternalConversationRepository {
  constructor(private db: Firestore) {}
  private col = () => this.db.collection('external_conversations');
  private chunks = () => this.db.collection('external_conversation_items');

  private fromDoc(data: Record<string, unknown>): ExternalConversationRecord {
    return {
      ...data,
      updatedRecordAt: toDate(data['updatedRecordAt']),
    } as ExternalConversationRecord;
  }

  async upsert(record: ExternalConversationRecord): Promise<void> {
    await this.col()
      .doc(record.id)
      .set(cleanUndefined(record as unknown as Record<string, unknown>));
  }

  async find(id: string): Promise<ExternalConversationRecord | null> {
    const doc = await this.col().doc(id).get();
    return doc.exists ? this.fromDoc(doc.data()!) : null;
  }

  async listByUser(
    userId: string,
    filter: {
      integration?: ExternalConversationRecord['integration'] | undefined;
      deviceId?: string | undefined;
    } = {},
  ): Promise<ExternalConversationRecord[]> {
    let query = this.col().where('userId', '==', userId);
    if (filter.integration) query = query.where('integration', '==', filter.integration);
    if (filter.deviceId) query = query.where('deviceId', '==', filter.deviceId);
    const snap = await query.get();
    return snap.docs.map((doc) => this.fromDoc(doc.data()));
  }

  async listByDeviceIntegration(
    deviceId: string,
    integration: ExternalConversationRecord['integration'],
  ): Promise<ExternalConversationRecord[]> {
    const snap = await this.col()
      .where('deviceId', '==', deviceId)
      .where('integration', '==', integration)
      .get();
    return snap.docs.map((doc) => this.fromDoc(doc.data()));
  }

  async writeItems(id: string, part: number, items: HistoryItem[]): Promise<void> {
    // Part 0 starts a fresh copy: drop any chunks left from an earlier sync.
    if (part === 0) await this.deleteChunks(id);
    const batch = this.db.batch();
    for (let start = 0; start < items.length; start += ITEMS_PER_CHUNK) {
      const index = part * 1000 + start / ITEMS_PER_CHUNK;
      batch.set(this.chunks().doc(`${id}__${String(index).padStart(6, '0')}`), {
        conversationId: id,
        index,
        items: items
          .slice(start, start + ITEMS_PER_CHUNK)
          .map((item) => cleanUndefined(item as unknown as Record<string, unknown>)),
      });
    }
    await batch.commit();
  }

  async readItems(id: string): Promise<HistoryItem[]> {
    const snap = await this.chunks().where('conversationId', '==', id).get();
    return snap.docs
      .map((doc) => doc.data() as { index: number; items: HistoryItem[] })
      .sort((a, b) => a.index - b.index)
      .flatMap((chunk) => chunk.items);
  }

  private async deleteChunks(id: string): Promise<void> {
    const snap = await this.chunks().where('conversationId', '==', id).get();
    if (snap.empty) return;
    const batch = this.db.batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.deleteChunks(id);
      await this.col().doc(id).delete();
    }
  }
}

export class FirestoreProviderUsageRepository implements IProviderUsageRepository {
  constructor(private db: Firestore) {}
  private col = () => this.db.collection('provider_usage');

  async upsert(record: ProviderUsageRecord): Promise<void> {
    await this.col()
      .doc(`${record.deviceId}__${record.integration}`)
      .set(cleanUndefined(record as unknown as Record<string, unknown>));
  }

  async listByUser(userId: string): Promise<ProviderUsageRecord[]> {
    const snap = await this.col().where('userId', '==', userId).get();
    return snap.docs.map((doc) => {
      const data = doc.data();
      return { ...data, receivedAt: toDate(data['receivedAt']) } as ProviderUsageRecord;
    });
  }

  async find(
    deviceId: string,
    integration: ProviderUsageRecord['integration'],
  ): Promise<ProviderUsageRecord | null> {
    const doc = await this.col().doc(`${deviceId}__${integration}`).get();
    if (!doc.exists) return null;
    const data = doc.data() ?? {};
    return { ...data, receivedAt: toDate(data['receivedAt']) } as ProviderUsageRecord;
  }

  async delete(deviceId: string, integration: ProviderUsageRecord['integration']): Promise<void> {
    await this.col().doc(`${deviceId}__${integration}`).delete();
  }
}

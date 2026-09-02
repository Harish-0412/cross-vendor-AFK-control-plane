import { EVENT_BUFFER_MAX_SIZE, SESSION_REGISTRY_MAX_SESSIONS } from '@freebuff/config';
import type {
  Session,
  SessionState,
  SessionConfig,
  SessionFilter,
  SessionSummary,
  EventEnvelope,
  AgentAdapter,
  ProjectInfo,
} from '@freebuff/protocol';
import { createSessionSummary, isTerminalState } from '@freebuff/protocol';

export interface SessionRecord {
  id: string;
  /** The session ID used by the adapter (may differ from gateway ID) */
  adapterSessionId?: string | undefined;
  project: ProjectInfo;
  adapter: AgentAdapter;
  config: SessionConfig;
  state: SessionState;
  processId?: number | undefined;
  startTime: Date;
  endTime?: Date | undefined;
  sandboxId?: string | undefined;
  sequenceNumber: number;
  eventBuffer: EventEnvelope[];
  eventCount: number;
  lastEventAt?: Date | undefined;
  lastEventType?: string;
  error?: Session['error'] | undefined;
  metadata: Record<string, unknown>;
}

export interface CreateSessionOptions {
  id: string;
  /** The session ID used by the adapter (may differ from gateway ID) */
  adapterSessionId?: string;
  config: SessionConfig;
  project: ProjectInfo;
  adapter: AgentAdapter;
}

export class SessionRegistry {
  private sessions: Map<string, SessionRecord> = new Map();
  private maxSessions: number;
  private maxEventBufferSize: number;

  constructor(options: { maxSessions?: number; maxEventBufferSize?: number } = {}) {
    this.maxSessions = options.maxSessions ?? SESSION_REGISTRY_MAX_SESSIONS;
    this.maxEventBufferSize = options.maxEventBufferSize ?? EVENT_BUFFER_MAX_SIZE;
  }

  create(options: CreateSessionOptions): SessionRecord {
    if (this.sessions.size >= this.maxSessions) {
      this.evictOldestTerminal();
      if (this.sessions.size >= this.maxSessions) {
        throw new Error(`Session registry full (${this.maxSessions}). Cannot create new session.`);
      }
    }

    const record: SessionRecord = {
      id: options.id,
      adapterSessionId: options.adapterSessionId,
      project: options.project,
      adapter: options.adapter,
      config: options.config,
      state: 'initializing',
      startTime: new Date(),
      sequenceNumber: 0,
      eventBuffer: [],
      eventCount: 0,
      metadata: { ...(options.config.metadata ?? {}) },
    };
    this.sessions.set(options.id, record);
    return record;
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  getOrThrow(id: string): SessionRecord {
    const record = this.get(id);
    if (!record) throw new Error(`Session not found: ${id}`);
    return record;
  }

  update(id: string, patch: Partial<SessionRecord>): SessionRecord {
    const record = this.getOrThrow(id);
    const updated = { ...record, ...patch };
    this.sessions.set(id, updated);
    return updated;
  }

  updateState(id: string, state: SessionState): SessionRecord {
    const record = this.getOrThrow(id);
    const now = new Date();
    const patch: Partial<SessionRecord> = { state };
    if (isTerminalState(state) && !record.endTime) {
      patch.endTime = now;
    }
    return this.update(id, patch);
  }

  appendEvent(id: string, event: EventEnvelope): void {
    const record = this.getOrThrow(id);
    const buffer = [...record.eventBuffer, event];
    if (buffer.length > this.maxEventBufferSize) {
      buffer.splice(0, buffer.length - this.maxEventBufferSize);
    }
    this.update(id, {
      eventBuffer: buffer,
      eventCount: record.eventCount + 1,
      sequenceNumber: event.sequence + 1,
      lastEventAt: event.occurredAt,
      lastEventType: event.eventType,
    });
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  list(): SessionRecord[] {
    return Array.from(this.sessions.values());
  }

  listByState(states: SessionState[]): SessionRecord[] {
    return this.list().filter((r) => states.includes(r.state));
  }

  listByAdapter(adapterId: string): SessionRecord[] {
    return this.list().filter((r) => r.adapter.metadata().id === adapterId);
  }

  listByProject(projectId: string): SessionRecord[] {
    return this.list().filter((r) => r.project.id === projectId);
  }

  filter(filter: SessionFilter): SessionRecord[] {
    let results = this.list();

    if (filter.projectId) {
      results = results.filter((r) => r.project.id === filter.projectId);
    }
    if (filter.adapterId) {
      results = results.filter((r) => r.adapter.metadata().id === filter.adapterId);
    }
    if (filter.state && filter.state.length > 0) {
      results = results.filter((r) => filter.state!.includes(r.state));
    }
    if (filter.startedAfter) {
      results = results.filter((r) => r.startTime >= filter.startedAfter!);
    }
    if (filter.startedBefore) {
      results = results.filter((r) => r.startTime <= filter.startedBefore!);
    }

    results.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? results.length;
    return results.slice(offset, offset + limit);
  }

  toSession(record: SessionRecord): Session {
    return {
      id: record.id,
      projectId: record.project.id,
      adapterId: record.adapter.metadata().id,
      state: record.state,
      processId: record.processId,
      startTime: record.startTime,
      endTime: record.endTime,
      sandboxId: record.sandboxId,
      sequenceNumber: record.sequenceNumber,
      lastEventAt: record.lastEventAt,
      error: record.error,
      metadata: { ...record.metadata },
    };
  }

  toSummary(record: SessionRecord): SessionSummary {
    return createSessionSummary(this.toSession(record), record.eventCount, record.lastEventType);
  }

  getActiveCount(): number {
    return this.listByState(['initializing', 'running', 'waiting_for_approval', 'paused']).length;
  }

  getTotalCount(): number {
    return this.sessions.size;
  }

  getFailedCount(): number {
    return this.listByState(['failed', 'crashed']).length;
  }

  getEventsSince(id: string, sequence: number): EventEnvelope[] {
    const record = this.getOrThrow(id);
    return record.eventBuffer.filter((e) => e.sequence > sequence);
  }

  clear(): void {
    this.sessions.clear();
  }

  private evictOldestTerminal(): void {
    const terminals = this.listByState(['completed', 'failed', 'cancelled', 'crashed']);
    if (terminals.length === 0) return;
    terminals.sort((a, b) => {
      const aEnd = a.endTime?.getTime() ?? 0;
      const bEnd = b.endTime?.getTime() ?? 0;
      return aEnd - bEnd;
    });
    const toEvict = terminals[0];
    if (toEvict) this.delete(toEvict.id);
  }
}

export function createSessionRegistry(
  options?: ConstructorParameters<typeof SessionRegistry>[0],
): SessionRegistry {
  return new SessionRegistry(options);
}

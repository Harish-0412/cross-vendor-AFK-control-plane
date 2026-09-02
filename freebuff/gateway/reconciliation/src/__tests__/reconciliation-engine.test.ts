import type { EventEnvelope } from '@freebuff/protocol';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { type ReconciliationEngine, createReconciliationEngine } from '../reconciliation-engine';
import type {
  SessionStateProvider,
  SessionUpdateApplier,
  EventStore,
  ReconciliationEvent,
} from '../types';

function createMockProviders() {
  const sessions = new Map<
    string,
    {
      sessionId: string;
      state: string;
      lastAckedSequence: number;
      lastEventAt?: Date;
      lastEventType?: string;
    }
  >();
  let globalAck = 0;

  const stateProvider: SessionStateProvider = {
    listAllSessions: () => Array.from(sessions.values()),
    getLastAckedGlobalSequence: () => globalAck,
  };

  const updatedStates = new Map<string, string>();
  const approvals = new Map<string, unknown[]>();

  const updateApplier: SessionUpdateApplier = {
    updateSessionState: vi.fn(async (sessionId, newState) => {
      updatedStates.set(sessionId, newState);
      return true;
    }),
    applyMissingApprovalDecision: vi.fn(async (sessionId, decision) => {
      const list = approvals.get(sessionId) ?? [];
      list.push(decision);
      approvals.set(sessionId, list);
      return true;
    }),
    getAllSessionsCount: () => sessions.size,
  };

  const events: Array<{ sessionId: string; envelope: EventEnvelope }> = [];
  const gaps: Array<{
    sessionId: string | null;
    fromSequence: number;
    toSequence: number;
    reason: string;
    reportedAt: Date;
  }> = [];

  const eventStore: EventStore = {
    getEventsSince: vi.fn(async () => []),
    getHighestSequence: vi.fn(async () => 100),
    replayEvent: vi.fn(async (sessionId, envelope) => {
      events.push({ sessionId, envelope });
      return true;
    }),
    recordUnrecoverableGap: vi.fn((gap) => {
      gaps.push(gap);
    }),
  };

  return {
    stateProvider,
    updateApplier,
    eventStore,
    sessions,
    updatedStates,
    approvals,
    events,
    gaps,
    setGlobalAck: (n: number) => {
      globalAck = n;
    },
    addSession: (s: { sessionId: string; state: string; lastAckedSequence: number }) => {
      sessions.set(s.sessionId, s);
    },
  };
}

describe('ReconciliationEngine', () => {
  let mocks: ReturnType<typeof createMockProviders>;
  let engine: ReconciliationEngine;

  beforeEach(() => {
    mocks = createMockProviders();
    engine = createReconciliationEngine(mocks.stateProvider, mocks.updateApplier, mocks.eventStore);
  });

  it('should initialize in idle state', () => {
    expect(engine.getStep()).toBe('idle');
    expect(engine.getLastResult()).toBeNull();
    expect(engine.getRunCount()).toBe(0);
    expect(engine.isInFlight()).toBe(false);
  });

  it('should collect session states', () => {
    mocks.addSession({ sessionId: 's1', state: 'running', lastAckedSequence: 5 });
    mocks.addSession({ sessionId: 's2', state: 'paused', lastAckedSequence: 3 });

    const states = engine.collectSessionStates();
    expect(states).toHaveLength(2);
    expect(states.find((s) => s.sessionId === 's1')?.state).toBe('running');
    expect(states.find((s) => s.sessionId === 's2')?.lastAckedSequence).toBe(3);
  });

  it('should build reconciliation request', () => {
    mocks.addSession({ sessionId: 's1', state: 'running', lastAckedSequence: 5 });
    mocks.setGlobalAck(10);

    const { request, signatureBase } = engine.buildReconciliationRequest(
      'dev_abc',
      'gw_abc',
      'thumb123',
    );

    expect(request.deviceId).toBe('dev_abc');
    expect(request.gatewayId).toBe('gw_abc');
    expect(request.lastAckedGlobalSequence).toBe(10);
    expect(request.sessionStates).toHaveLength(1);
    expect(request.certificateThumbprint).toBe('thumb123');
    expect(typeof signatureBase).toBe('string');
  });

  it('should sign request when signFn provided', () => {
    const signFn = vi.fn().mockReturnValue('signed-data');
    const { request } = engine.buildReconciliationRequest('dev_abc', 'gw_abc', 'thumb123', signFn);
    expect(signFn).toHaveBeenCalled();
    expect(request.signature).toBe('signed-data');
  });

  it('should process empty reconciliation response', async () => {
    const response = {
      deviceId: 'dev_abc',
      replayEvents: [],
      sessionUpdates: [],
      reconciledAt: new Date(),
      newAckBaseline: 10,
    };

    const result = await engine.processReconciliationResponse(response);
    expect(result.success).toBe(true);
    expect(result.eventsReplayed).toBe(0);
    expect(result.sessionUpdatesApplied).toBe(0);
    expect(result.newAckBaseline).toBe(10);
    expect(engine.getRunCount()).toBe(1);
    expect(engine.getStep()).toBe('idle');
  });

  it('should replay durable events from response', async () => {
    mocks.addSession({ sessionId: 's1', state: 'running', lastAckedSequence: 5 });

    const response = {
      deviceId: 'dev_abc',
      replayEvents: [
        {
          sequence: 6,
          event: {
            eventId: 'evt-1',
            sessionId: 's1',
            eventType: 'session.approval_granted',
            sequence: 6,
            occurredAt: new Date(),
          } as EventEnvelope,
        },
        {
          sequence: 7,
          event: {
            eventId: 'evt-2',
            sessionId: 's1',
            eventType: 'session.output',
            sequence: 7,
            occurredAt: new Date(),
          } as EventEnvelope,
        },
      ],
      sessionUpdates: [],
      reconciledAt: new Date(),
      newAckBaseline: 7,
    };

    const result = await engine.processReconciliationResponse(response, { onlyDurable: true });
    expect(result.eventsReplayed).toBe(1); // Only durable event replayed
    expect(mocks.events).toHaveLength(1);
    expect(mocks.events[0].envelope.eventType).toBe('session.approval_granted');
  });

  it('should apply session state updates', async () => {
    const response = {
      deviceId: 'dev_abc',
      replayEvents: [],
      sessionUpdates: [
        { sessionId: 's1', newState: 'running' },
        { sessionId: 's2', newState: 'completed', missingApprovalDecisions: [{ approved: true }] },
      ],
      reconciledAt: new Date(),
      newAckBaseline: 5,
    };

    const result = await engine.processReconciliationResponse(response);
    expect(result.sessionUpdatesApplied).toBe(3); // 2 state updates + 1 approval
    expect(mocks.updatedStates.get('s1')).toBe('running');
    expect(mocks.updatedStates.get('s2')).toBe('completed');
    expect(mocks.approvals.get('s2')).toHaveLength(1);
  });

  it('should record unrecoverable gaps', async () => {
    const response = {
      deviceId: 'dev_abc',
      replayEvents: [],
      sessionUpdates: [
        {
          sessionId: 's1',
          unrecoverableGaps: [{ from: 3, to: 5, reason: 'data loss' }],
        },
      ],
      globalGapInfo: { from: 8, to: 10, reason: 'network partition' },
      reconciledAt: new Date(),
      newAckBaseline: 10,
    };

    const result = await engine.processReconciliationResponse(response);
    expect(result.unrecoverableGaps).toHaveLength(2);
    expect(mocks.gaps).toHaveLength(2);
    expect(mocks.gaps[0].fromSequence).toBe(3);
    expect(mocks.gaps[1].fromSequence).toBe(8);
  });

  it('should emit events during reconciliation', async () => {
    const events: ReconciliationEvent[] = [];
    engine.onEvent((e) => events.push(e));

    const response = {
      deviceId: 'dev_abc',
      replayEvents: [],
      sessionUpdates: [{ sessionId: 's1', newState: 'running' }],
      reconciledAt: new Date(),
      newAckBaseline: 5,
    };

    await engine.processReconciliationResponse(response);
    expect(events.some((e) => e.type === 'step_changed')).toBe(true);
    expect(events.some((e) => e.type === 'update_applied')).toBe(true);
    expect(events.some((e) => e.type === 'run_completed')).toBe(true);
  });

  it('should handle replay errors gracefully', async () => {
    vi.mocked(mocks.eventStore.replayEvent).mockRejectedValueOnce(new Error('disk full'));

    const response = {
      deviceId: 'dev_abc',
      replayEvents: [
        {
          sequence: 1,
          event: {
            eventId: 'evt-1',
            sessionId: 's1',
            eventType: 'session.created',
            sequence: 1,
            occurredAt: new Date(),
          } as EventEnvelope,
        },
      ],
      sessionUpdates: [],
      reconciledAt: new Date(),
      newAckBaseline: 1,
    };

    const result = await engine.processReconciliationResponse(response);
    // Should retry and succeed on second attempt (maxRetryOnReplayError = 2)
    expect(result.success).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('should track gap history', async () => {
    const response = {
      deviceId: 'dev_abc',
      replayEvents: [],
      sessionUpdates: [],
      globalGapInfo: { from: 1, to: 5, reason: 'test' },
      reconciledAt: new Date(),
      newAckBaseline: 5,
    };

    await engine.processReconciliationResponse(response);
    const history = engine.getGapHistory();
    expect(history).toHaveLength(1);
    expect(history[0].fromSequence).toBe(1);
  });

  it('should unsubscribe from events', async () => {
    const events: ReconciliationEvent[] = [];
    const unsub = engine.onEvent((e) => events.push(e));

    const response = {
      deviceId: 'dev_abc',
      replayEvents: [],
      sessionUpdates: [],
      reconciledAt: new Date(),
      newAckBaseline: 0,
    };

    await engine.processReconciliationResponse(response);
    const countBefore = events.length;
    unsub();

    await engine.processReconciliationResponse(response);
    expect(events.length).toBe(countBefore);
  });

  it('should provide gap detector', () => {
    expect(engine.getGapDetector()).toBeDefined();
    expect(engine.getGapDetector().isDurable('session.created')).toBe(true);
  });
});

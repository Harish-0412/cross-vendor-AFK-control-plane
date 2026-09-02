import type {
  AgentAdapter,
  AgentMetadata,
  AgentInstallationResult,
  AgentValidationResult,
  SessionConfig,
  SessionState,
  Session,
  EventStream,
  EventSubscriber,
  ApprovalAction,
} from '@freebuff/protocol';
import { generateSessionId, createDefaultAgentHealth, ALL_PLATFORMS } from '@freebuff/protocol';

import { MockEventStream } from './event-stream';
import {
  DEFAULT_SCENARIO_CONFIG,
  buildScenario,
  listScenarios,
  type ScenarioConfig,
  type ScenarioName,
} from './scenarios';

interface MockSessionInternal {
  session: Session;
  config: SessionConfig;
  stream: MockEventStream;
  sequenceCounter: number;
  running: boolean;
  abortRequested: boolean;
  pauseRequested: boolean;
  awaitingApproval: Map<string, { resolve: (approved: boolean) => void; timeout: NodeJS.Timeout }>;
  generatorTimer: NodeJS.Timeout | null;
  scenarioEvents?: ReturnType<typeof buildScenario>;
  scenarioConfig: ScenarioConfig;
  ctx: {
    turn: number;
    eventIndex: number;
    variables: Record<string, unknown>;
  };
}

export class MockAdapter implements AgentAdapter {
  private sessions: Map<string, MockSessionInternal> = new Map();
  private _metadata: AgentMetadata;
  private shutdownRequested = false;

  constructor() {
    this._metadata = {
      id: 'mock',
      name: 'Mock Agent',
      version: '1.0.0',
      platform: [...ALL_PLATFORMS],
      capabilities: {
        sessionCreation: 'supported',
        promptDelivery: 'supported',
        streaming: 'supported',
        cancellation: 'supported',
        diffCollection: 'supported',
        approvalInterception: 'supported',
        checkpointRecovery: 'partial',
        multiTurn: 'supported',
        fileOperations: 'supported',
        toolExecution: 'supported',
      },
      description: 'Deterministic mock agent for testing all session states and behaviors.',
      tags: ['mock', 'testing', 'deterministic'],
      license: 'MIT',
    };
  }

  metadata(): AgentMetadata {
    return { ...this._metadata };
  }

  async installOrDetect(): Promise<AgentInstallationResult> {
    return {
      success: true,
      installedVersion: this._metadata.version,
      path: process.execPath,
      warnings: ['Mock adapter is always available - no real agent is installed.'],
    };
  }

  async validateEnvironment(): Promise<AgentValidationResult> {
    return {
      valid: true,
      errors: [],
      warnings: [],
      checks: {
        node_version: process.versions.node.split('.').map(Number)[0]! >= 20,
        memory_available: true,
        disk_available: true,
      },
    };
  }

  async startSession(config: SessionConfig): Promise<string> {
    if (this.shutdownRequested) {
      throw new Error('MockAdapter is shutting down');
    }

    const sessionId = generateSessionId();
    const scenarioName = this.extractScenario(config);
    type Cfg = ScenarioConfig;
    const scenarioConfig: Cfg = {
      scenario: scenarioName,
      baseDelayMs: DEFAULT_SCENARIO_CONFIG.baseDelayMs,
      jitterMs: DEFAULT_SCENARIO_CONFIG.jitterMs,
    };
    const approvalCount = config.metadata?.approvalCount as number | undefined;
    const messageCount = config.metadata?.messageCount as number | undefined;
    const toolCallCount = config.metadata?.toolCallCount as number | undefined;
    const fileChangeCount = config.metadata?.fileChangeCount as number | undefined;
    const crashAtEvent = config.metadata?.crashAtEvent as number | undefined;
    if (approvalCount !== undefined) scenarioConfig.approvalCount = approvalCount;
    if (messageCount !== undefined) scenarioConfig.messageCount = messageCount;
    if (toolCallCount !== undefined) scenarioConfig.toolCallCount = toolCallCount;
    if (fileChangeCount !== undefined) scenarioConfig.fileChangeCount = fileChangeCount;
    if (crashAtEvent !== undefined) scenarioConfig.crashAtEvent = crashAtEvent;

    const stream = new MockEventStream();
    const events = buildScenario(scenarioConfig);

    const internal: MockSessionInternal = {
      session: {
        id: sessionId,
        projectId: (config.metadata?.projectId as string | undefined) ?? 'proj_mock',
        adapterId: this._metadata.id,
        state: 'initializing',
        startTime: new Date(),
        sequenceNumber: 0,
        metadata: {
          scenario: scenarioName,
          ...(config.metadata ?? {}),
        },
      },
      config,
      stream,
      sequenceCounter: 0,
      running: false,
      abortRequested: false,
      pauseRequested: false,
      awaitingApproval: new Map(),
      generatorTimer: null,
      scenarioEvents: events,
      scenarioConfig,
      ctx: {
        turn: 0,
        eventIndex: 0,
        variables: {},
      },
    };

    this.sessions.set(sessionId, internal);
    this.beginScenario(sessionId);

    return sessionId;
  }

  private extractScenario(config: SessionConfig): ScenarioName {
    const fromMeta = config.metadata?.scenario as ScenarioName | undefined;
    if (fromMeta) return fromMeta;
    if (config.metadata?.shouldFail) return 'failed';
    if (config.metadata?.shouldCancel) return 'cancelled';
    if (config.metadata?.needApproval) return 'with_approval';
    if (config.metadata?.longRunning) return 'long_task';
    if (config.metadata?.multiTurn) return 'multi_turn';
    return 'simple';
  }

  private beginScenario(sessionId: string): void {
    const internal = this.sessions.get(sessionId);
    if (!internal || !internal.scenarioEvents) return;

    internal.session.state = 'running';
    internal.running = true;
    this.runNextEvent(sessionId);
  }

  private runNextEvent(sessionId: string): void {
    const internal = this.sessions.get(sessionId);
    if (!internal || !internal.scenarioEvents) return;

    if (internal.abortRequested) {
      this.finishWithCancellation(sessionId);
      return;
    }

    if (internal.pauseRequested) {
      internal.generatorTimer = setTimeout(
        () => this.runNextEvent(sessionId),
        internal.scenarioConfig.baseDelayMs ?? DEFAULT_SCENARIO_CONFIG.baseDelayMs,
      );
      return;
    }

    const events = internal.scenarioEvents;
    if (internal.ctx.eventIndex >= events.length) {
      this.cleanupSessionInternals(sessionId);
      return;
    }

    const template = events[internal.ctx.eventIndex]!;
    const delay =
      (template.delayMs ??
        internal.scenarioConfig.baseDelayMs ??
        DEFAULT_SCENARIO_CONFIG.baseDelayMs) +
      Math.random() * (internal.scenarioConfig.jitterMs ?? DEFAULT_SCENARIO_CONFIG.jitterMs);

    internal.generatorTimer = setTimeout(() => {
      if (internal.abortRequested) {
        this.finishWithCancellation(sessionId);
        return;
      }

      const payload = template.payloadFactory?.({
        sessionId,
        config: internal.scenarioConfig,
        turn: internal.ctx.turn,
        eventIndex: internal.ctx.eventIndex,
        totalEvents: events.length,
        variables: internal.ctx.variables,
      });

      if (template.type === 'session.tool_call' || template.type === 'session.thinking') {
        internal.ctx.turn++;
      }

      const sequence = internal.sequenceCounter++;
      internal.session.sequenceNumber = sequence;
      internal.session.lastEventAt = new Date();

      internal.stream.publish({
        eventType: template.type,
        sessionId,
        sequence,
        payload,
      });

      if (template.type === 'session.approval_required') {
        const approvalId =
          (payload as { approvalId?: string })?.approvalId ??
          `appr_${sessionId.slice(-6)}_${Date.now()}`;
        internal.session.state = 'waiting_for_approval';
        this.handleAwaitingApproval(sessionId, approvalId, delay * 10);
      } else if (template.type === 'session.completed') {
        internal.session.state = 'completed';
        internal.session.endTime = new Date();
        internal.running = false;
      } else if (template.type === 'session.failed') {
        internal.session.state = 'failed';
        internal.session.endTime = new Date();
        internal.running = false;
      } else if (template.type === 'session.cancelled') {
        internal.session.state = 'cancelled';
        internal.session.endTime = new Date();
        internal.running = false;
      }

      internal.ctx.eventIndex++;
      if (internal.running && !internal.abortRequested) {
        this.runNextEvent(sessionId);
      } else if (!internal.running) {
        this.cleanupSessionInternals(sessionId);
      }
    }, delay);
  }

  private handleAwaitingApproval(sessionId: string, approvalId: string, timeoutMs: number): void {
    const internal = this.sessions.get(sessionId);
    if (!internal) return;

    const timeout = setTimeout(() => {
      const pending = internal.awaitingApproval.get(approvalId);
      if (pending) {
        internal.awaitingApproval.delete(approvalId);
        pending.resolve(false);
        internal.session.state = 'failed';
        internal.session.endTime = new Date();
        internal.running = false;
        internal.stream.publish({
          eventType: 'session.failed',
          sessionId,
          sequence: internal.sequenceCounter++,
          payload: {
            errorCode: 'APPROVAL_TIMEOUT',
            errorMessage: `Approval ${approvalId} timed out`,
            fatal: true,
            durationMs: timeoutMs,
          },
        });
      }
    }, timeoutMs);

    const promise = new Promise<boolean>((resolve) => {
      internal.awaitingApproval.set(approvalId, { resolve, timeout });
    });

    promise.then((approved) => {
      internal.awaitingApproval.delete(approvalId);
      clearTimeout(timeout);
      internal.session.state = approved ? 'running' : 'failed';
      if (!approved) {
        internal.running = false;
        internal.session.endTime = new Date();
      }
    });
  }

  private finishWithCancellation(sessionId: string): void {
    const internal = this.sessions.get(sessionId);
    if (!internal) return;
    internal.session.state = 'cancelled';
    internal.session.endTime = new Date();
    internal.running = false;
    internal.stream.publish({
      eventType: 'session.cancelled',
      sessionId,
      sequence: internal.sequenceCounter++,
      payload: {
        reason: 'Session aborted by gateway',
        cancelledBy: 'gateway',
        cancelledAt: new Date(),
      },
    });
    this.cleanupSessionInternals(sessionId);
  }

  private cleanupSessionInternals(sessionId: string): void {
    const internal = this.sessions.get(sessionId);
    if (!internal) return;
    if (internal.generatorTimer !== null) {
      clearTimeout(internal.generatorTimer);
      internal.generatorTimer = null;
    }
    for (const [, pending] of internal.awaitingApproval) {
      clearTimeout(pending.timeout);
    }
    internal.awaitingApproval.clear();
    setTimeout(() => internal.stream.close(), 500);
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const internal = this.sessions.get(sessionId);
    if (!internal) throw new Error(`Session not found: ${sessionId}`);

    internal.stream.publish({
      eventType: 'session.message',
      sessionId,
      sequence: internal.sequenceCounter++,
      payload: {
        role: 'user',
        content: message,
        receivedAt: new Date(),
      },
    });
  }

  async sendInput(sessionId: string, data: string): Promise<void> {
    const internal = this.sessions.get(sessionId);
    if (!internal) throw new Error(`Session not found: ${sessionId}`);

    internal.stream.publish({
      eventType: 'session.output',
      sessionId,
      sequence: internal.sequenceCounter++,
      payload: {
        stream: 'stdin' as const,
        content: data,
        timestamp: new Date(),
      },
    });
  }

  streamEvents(sessionId: string, subscriber?: Partial<EventSubscriber>): EventStream {
    const internal = this.sessions.get(sessionId);
    if (!internal) throw new Error(`Session not found: ${sessionId}`);

    if (subscriber) {
      internal.stream.subscribe(subscriber);
    }

    const stream = internal.stream;
    return {
      [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream),
      unsubscribe: () => stream.unsubscribe(),
      closed: stream.isClosed,
    };
  }

  async requestApproval(
    sessionId: string,
    action: ApprovalAction,
  ): Promise<{ approved: boolean; reason?: string }> {
    const internal = this.sessions.get(sessionId);
    if (!internal) throw new Error(`Session not found: ${sessionId}`);

    internal.session.state = 'waiting_for_approval';
    const approvalId = action.id;
    internal.stream.publish({
      eventType: 'session.approval_required',
      sessionId,
      sequence: internal.sequenceCounter++,
      payload: {
        approvalId,
        action: action.type,
        description: action.description,
        riskLevel: action.riskLevel,
        scope: action.type,
        details: action.details,
        timeoutMs: action.timeoutMs,
        requestedAt: new Date(),
      },
    });

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        internal.awaitingApproval.delete(approvalId);
        internal.session.state = 'running';
        resolve({ approved: true, reason: 'Mock adapter auto-approved after timeout' });
      }, action.timeoutMs ?? 1000);
      internal.awaitingApproval.set(approvalId, {
        resolve: (approved) => {
          clearTimeout(timeout);
          resolve({ approved, reason: approved ? 'Approved' : 'Denied by user' });
        },
        timeout,
      });
    });
  }

  async submitApprovalDecision(
    sessionId: string,
    approvalId: string,
    approved: boolean,
    reason?: string,
  ): Promise<void> {
    const internal = this.sessions.get(sessionId);
    if (!internal) throw new Error(`Session not found: ${sessionId}`);

    const pending = internal.awaitingApproval.get(approvalId);
    if (!pending) {
      throw new Error(`Approval request not found or already resolved: ${approvalId}`);
    }

    clearTimeout(pending.timeout);
    internal.awaitingApproval.delete(approvalId);

    internal.stream.publish({
      eventType: approved ? 'session.approval_granted' : 'session.approval_denied',
      sessionId,
      sequence: internal.sequenceCounter++,
      payload: {
        approvalId,
        decision: approved ? 'granted' : 'denied',
        decidedAt: new Date(),
        decidedBy: 'user',
        reason,
      },
    });

    pending.resolve(approved);
  }

  async abortSession(sessionId: string, _reason: string, force = false): Promise<void> {
    const internal = this.sessions.get(sessionId);
    if (!internal) return;

    internal.abortRequested = true;
    if (force && internal.generatorTimer !== null) {
      clearTimeout(internal.generatorTimer);
      internal.generatorTimer = null;
      this.finishWithCancellation(sessionId);
    }
  }

  async collectDiff(sessionId: string): Promise<string> {
    const internal = this.sessions.get(sessionId);
    if (!internal) throw new Error(`Session not found: ${sessionId}`);

    return `diff --git a/changes.md b/changes.md
index 0000000..abcdefg 100644
--- a/changes.md
+++ b/changes.md
@@ -0,0 +1,7 @@
+# Mock Session ${sessionId.slice(0, 12)}...
+
+- Scenario: ${internal.scenarioConfig.scenario}
+- Events emitted: ${internal.ctx.eventIndex}
+- Turns executed: ${internal.ctx.turn}
+- Diff collected at: ${new Date().toISOString()}
`;
  }

  async getState(sessionId: string): Promise<SessionState> {
    return this.sessions.get(sessionId)?.session.state ?? 'failed';
  }

  async getSession(sessionId: string): Promise<Session | undefined> {
    const internal = this.sessions.get(sessionId);
    return internal ? { ...internal.session } : undefined;
  }

  async cleanupSession(sessionId: string): Promise<void> {
    const internal = this.sessions.get(sessionId);
    if (!internal) return;

    internal.abortRequested = true;
    this.cleanupSessionInternals(sessionId);
    this.sessions.delete(sessionId);
  }

  async pauseSession(sessionId: string): Promise<void> {
    const internal = this.sessions.get(sessionId);
    if (!internal) throw new Error(`Session not found: ${sessionId}`);
    internal.pauseRequested = true;
    internal.session.state = 'paused';
  }

  async resumeSession(sessionId: string): Promise<void> {
    const internal = this.sessions.get(sessionId);
    if (!internal) throw new Error(`Session not found: ${sessionId}`);
    internal.pauseRequested = false;
    if (internal.session.state === 'paused') {
      internal.session.state = 'running';
    }
  }

  async checkpointSession(sessionId: string): Promise<string> {
    const internal = this.sessions.get(sessionId);
    if (!internal) throw new Error(`Session not found: ${sessionId}`);

    const checkpointId = `chk_${sessionId.slice(-6)}_${Date.now().toString(36)}`;
    internal.stream.publish({
      eventType: 'session.checkpoint',
      sessionId,
      sequence: internal.sequenceCounter++,
      payload: {
        checkpointId,
        turnNumber: internal.ctx.turn,
        eventCount: internal.ctx.eventIndex,
        timestamp: new Date(),
        digest: `sha256:${Buffer.from(`${sessionId}:${internal.ctx.turn}:${internal.ctx.eventIndex}`).toString('hex')}`,
      },
    });
    return checkpointId;
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    for (const sessionId of Array.from(this.sessions.keys())) {
      try {
        await this.abortSession(sessionId, 'Adapter shutdown', true);
      } catch {
        // ignore shutdown errors
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    this.sessions.clear();
  }

  listScenarios() {
    return listScenarios();
  }

  getActiveSessions(): string[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.running)
      .map((s) => s.session.id);
  }

  getHealth() {
    return {
      ...createDefaultAgentHealth(),
      status: this.shutdownRequested ? ('unhealthy' as const) : ('healthy' as const),
      lastCheckAt: new Date(),
      checks: {
        installed: 'pass' as const,
        memory: 'pass' as const,
        active_sessions: this.sessions.size < 100 ? ('pass' as const) : ('warn' as const),
      },
    };
  }
}

export function createMockAdapter(): MockAdapter {
  return new MockAdapter();
}

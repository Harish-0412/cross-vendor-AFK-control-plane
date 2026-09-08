import * as os from 'node:os';

import { type CheckpointStore, createCheckpointStore } from '@freebuff/checkpoint';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS, mergeGatewayOptions } from '@freebuff/config';
import { type HealthModule, createHealthModule } from '@freebuff/health';
import { createMockAdapter } from '@freebuff/mock-adapter';
import type {
  GatewayCore,
  GatewayOptions,
  GatewayStatus,
  ResourceUsage,
  Session,
  SessionConfig,
  SessionFilter,
  SessionSummary,
  EventSubscriber,
  ProjectInfo,
  ProjectRegistrationOptions,
  ProjectValidation,
  ProjectStats,
  AgentInfo,
  GatewayEvent,
  EventEnvelope,
  SessionState,
  AgentAdapter,
} from '@freebuff/protocol';
import {
  generateGatewayId,
  generateDeviceId,
  generateSessionId,
  generateEventId,
  GATEWAY_VERSION,
  DEFAULT_GATEWAY_FEATURES,
} from '@freebuff/protocol';
import { type TunnelClient, createTunnelClient } from '@freebuff/tunnel';

import { type AgentManager, createAgentManager } from './agent-manager';
import { type EventBus, createEventBus } from './event-bus';
import { type ProjectManager, createProjectManager } from './project-manager';
import {
  type SessionRegistry,
  createSessionRegistry,
  type SessionRecord,
} from './session-registry';

export type { GatewayOptions } from '@freebuff/protocol';

export interface GatewayModules {
  checkpointStore: CheckpointStore;
  healthModule: HealthModule;
  tunnelClient: TunnelClient;
}

export class GatewayImpl implements GatewayCore {
  readonly options: Required<GatewayOptions> & {
    apiServer: NonNullable<GatewayOptions['apiServer']>;
    redaction: NonNullable<GatewayOptions['redaction']>;
  };

  private readonly gatewayId: string;
  private readonly deviceId: string;
  private readonly startedAt: Date = new Date();
  private readonly registry: SessionRegistry;
  private readonly projects: ProjectManager;
  private readonly agents: AgentManager;
  private readonly bus: EventBus;
  private readonly eventListeners: Set<() => void> = new Set();
  private readonly gatewayListeners: Set<(event: GatewayEvent) => void> = new Set();
  private readonly checkpointStore: CheckpointStore;
  private readonly healthModule: HealthModule;
  private readonly tunnelClient: TunnelClient;
  private shuttingDown = false;
  private totalSessionsEver = 0;

  constructor(options: GatewayOptions = {}) {
    this.options = mergeGatewayOptions(options) as typeof this.options;
    this.gatewayId = this.options.gatewayId ?? generateGatewayId();
    this.deviceId = this.options.deviceId ?? generateDeviceId();
    this.registry = createSessionRegistry();
    this.projects = createProjectManager(this.options.projectRoots);
    this.agents = createAgentManager();
    this.bus = createEventBus();

    // Initialize new Phase 1 modules
    this.checkpointStore = createCheckpointStore();
    this.healthModule = createHealthModule({
      gatewayId: this.gatewayId,
      deviceId: this.deviceId,
      heartbeatIntervalMs: 0, // Disabled by default; enable via config
      heartbeatOverdueThresholdMs: 30000,
    });
    this.tunnelClient = createTunnelClient({
      controlPlaneUrl: '', // Not connected yet; Phase 2
      deviceId: this.deviceId,
      gatewayId: this.gatewayId,
    });

    // Wire health module checks for gateway components
    this.healthModule.registerCheck('session-registry', () => ({
      name: 'session-registry',
      status: this.registry.getActiveCount() > 0 ? 'healthy' : 'healthy',
      message: `${this.registry.getActiveCount()} active, ${this.registry.getTotalCount()} total sessions`,
      lastCheckedAt: new Date(),
      durationMs: 0,
      metrics: {
        activeCount: this.registry.getActiveCount(),
        totalCount: this.registry.getTotalCount(),
        failedCount: this.registry.getFailedCount(),
      },
    }));

    this.healthModule.registerCheck('adapter-manager', () => ({
      name: 'adapter-manager',
      status: this.agents.getRegisteredCount() > 0 ? 'healthy' : 'degraded',
      message: `${this.agents.getRegisteredCount()} adapters registered, ${this.agents.getInstalledCount()} installed`,
      lastCheckedAt: new Date(),
      durationMs: 0,
      metrics: {
        registered: this.agents.getRegisteredCount(),
        installed: this.agents.getInstalledCount(),
      },
    }));

    this.healthModule.registerCheck('checkpoint-store', () => ({
      name: 'checkpoint-store',
      status: 'healthy',
      message: `${this.checkpointStore.getStats().totalCheckpoints} checkpoints`,
      lastCheckedAt: new Date(),
      durationMs: 0,
      metrics: { ...this.checkpointStore.getStats() } as unknown as Record<string, unknown>,
    }));

    this.healthModule.registerCheck('tunnel-client', () => ({
      name: 'tunnel-client',
      status: this.tunnelClient.isConnected() ? 'healthy' : 'degraded',
      message: this.tunnelClient.isConnected()
        ? 'Tunnel connected'
        : 'Tunnel not connected (Phase 2)',
      lastCheckedAt: new Date(),
      durationMs: 0,
      metrics: { ...this.tunnelClient.getStats() } as unknown as Record<string, unknown>,
    }));

    this.agents.register(createMockAdapter());

    this.emitGatewayEvent({ type: 'gateway.started', timestamp: new Date() });
  }

  /**
   * Get access to the gateway's internal modules.
   */
  getModules(): GatewayModules {
    return {
      checkpointStore: this.checkpointStore,
      healthModule: this.healthModule,
      tunnelClient: this.tunnelClient,
    };
  }

  /**
   * Get the health report for this gateway.
   */
  async getHealthReport() {
    return this.healthModule.getReport();
  }

  /**
   * Get the health module instance.
   */
  getHealth(): HealthModule {
    return this.healthModule;
  }

  /**
   * Get the checkpoint store instance.
   */
  getCheckpointStore(): CheckpointStore {
    return this.checkpointStore;
  }

  /**
   * Get the tunnel client instance.
   */
  getTunnelClient(): TunnelClient {
    return this.tunnelClient;
  }

  getGatewayId(): string {
    return this.gatewayId;
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  async getStatus(): Promise<GatewayStatus> {
    const agents = await this.listAgents();
    const resources = this.measureResources();
    const activeSessions = this.registry.getActiveCount();

    return {
      version: GATEWAY_VERSION,
      gatewayId: this.gatewayId,
      deviceId: this.deviceId,
      uptimeMs: Date.now() - this.startedAt.getTime(),
      startedAt: this.startedAt,
      activeSessions,
      totalSessions: this.totalSessionsEver,
      failedSessions: this.registry.getFailedCount(),
      agents,
      resources,
      sandbox: {
        available: this.options.sandboxEnabled,
        active: 0,
        totalCreated: 0,
        totalDestroyed: 0,
        orphansCleaned: 0,
      },
      features: {
        ...DEFAULT_GATEWAY_FEATURES,
        sandboxIsolation: this.options.sandboxEnabled,
        secretRedaction: this.options.redaction.enabled,
      },
    };
  }

  async shutdown(graceful = true, timeoutMs?: number): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    const timeout = timeoutMs ?? this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const deadline = Date.now() + timeout;

    this.emitGatewayEvent({ type: 'gateway.shutting_down', timestamp: new Date() });

    if (graceful) {
      const sessions = this.registry.listByState([
        'initializing',
        'running',
        'waiting_for_approval',
        'paused',
      ]);
      for (const record of sessions) {
        if (Date.now() > deadline) break;
        try {
          const adapterSid = this.getAdapterSessionId(record);
          await record.adapter.abortSession(adapterSid, 'Gateway shutdown', false);
        } catch {
          // swallow
        }
      }
    }

    for (const adapter of this.agents.list()) {
      if (Date.now() > deadline) break;
      try {
        if (adapter.shutdown) await adapter.shutdown();
      } catch {
        // swallow
      }
    }

    // Shutdown new modules
    await this.healthModule.shutdown();
    await this.tunnelClient.shutdown();
    await this.checkpointStore.shutdown();

    this.registry.clear();
    this.agents.clear();
    this.projects.clear();
    this.bus.clear();

    this.emitGatewayEvent({ type: 'gateway.shutdown', timestamp: new Date() });
    for (const unsub of this.eventListeners) unsub();
    this.eventListeners.clear();
    this.gatewayListeners.clear();
  }

  async detectAgents(): Promise<AgentInfo[]> {
    return this.agents.detectAll(true);
  }

  async listAgents(): Promise<AgentInfo[]> {
    return this.agents.detectAll(false);
  }

  async getAgent(agentId: string): Promise<AgentInfo> {
    if (!this.agents.has(agentId)) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    return this.agents.detect(agentId, false);
  }

  async listProjects(): Promise<ProjectInfo[]> {
    return this.projects.listProjects();
  }

  async getProject(projectId: string): Promise<ProjectInfo> {
    return this.projects.getProject(projectId);
  }

  async validateProject(projectRoot: string): Promise<ProjectValidation> {
    return this.projects.validateProject(projectRoot);
  }

  async registerProject(options: ProjectRegistrationOptions): Promise<ProjectInfo> {
    const project = await this.projects.registerProject(options);
    this.emitGatewayEvent({
      type: 'project.registered',
      timestamp: new Date(),
      payload: { projectId: project.id, root: project.root },
    });
    return project;
  }

  async removeProject(projectId: string): Promise<void> {
    await this.projects.removeProject(projectId);
    this.emitGatewayEvent({
      type: 'project.removed',
      timestamp: new Date(),
      payload: { projectId },
    });
  }

  async getProjectStats(): Promise<ProjectStats> {
    return this.projects.getProjectStats(
      this.registry.getActiveCount(),
      this.registry.getTotalCount(),
    );
  }

  async createSession(config: SessionConfig): Promise<Session> {
    if (this.shuttingDown) {
      throw new Error('Gateway is shutting down, cannot create session');
    }

    const adapter = this.agents.get(config.adapter);
    if (!adapter) {
      throw new Error(
        `Unknown adapter: ${config.adapter}. Available: ${this.agents
          .list()
          .map((a) => a.metadata().id)
          .join(', ')}`,
      );
    }

    const validation = await this.validateProject(config.projectRoot);
    if (!validation.valid) {
      throw new Error(`Invalid project root: ${validation.errors.join('; ')}`);
    }

    let project = this.projects.findByRoot(validation.resolvedRoot);
    if (!project) {
      project = await this.projects.registerProject({
        root: validation.resolvedRoot,
        autoDetectGit: validation.isGitRepo,
        allowedPaths: validation.writablePaths,
        deniedPaths: validation.deniedPaths,
        networkCapabilities: validation.networkCapabilities,
      });
    }

    const gatewaySessionId = generateSessionId();
    let adapterSessionId: string;

    try {
      // Start the adapter session first to get its session ID
      adapterSessionId = await adapter.startSession(config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to start adapter session: ${message}`);
    }

    const record = this.registry.create({
      id: gatewaySessionId,
      adapterSessionId,
      config,
      project,
      adapter,
    });

    // Create checkpoint for crash recovery
    this.checkpointStore.create({
      sessionId: gatewaySessionId,
      gatewayId: this.gatewayId,
      adapterId: config.adapter,
      projectId: project.id,
    });

    this.publishEnvelope(gatewaySessionId, 'session.created', {
      projectId: project.id,
      adapterId: config.adapter,
      validation,
      adapterSessionId,
    });

    this.registry.updateState(gatewaySessionId, 'running');
    this.totalSessionsEver++;

    // Wire events using the adapter's session ID
    this.wireAdapterEvents(gatewaySessionId, adapter, adapterSessionId);

    return this.registry.toSession(record);
  }

  async getSession(sessionId: string): Promise<Session> {
    const record = this.registry.getOrThrow(sessionId);
    try {
      const adapterSid = this.getAdapterSessionId(record);
      const state = await record.adapter.getState(adapterSid);
      if (state !== record.state) {
        this.registry.updateState(sessionId, state);
      }
    } catch {
      // ignore state sync errors
    }
    return this.registry.toSession(this.registry.getOrThrow(sessionId));
  }

  async listSessions(filter: SessionFilter = {}): Promise<Session[]> {
    return this.registry.filter(filter).map((r) => this.registry.toSession(r));
  }

  async listSessionSummaries(filter: SessionFilter = {}): Promise<SessionSummary[]> {
    return this.registry.filter(filter).map((r) => this.registry.toSummary(r));
  }

  /** Get the adapter's session ID for a given gateway session */
  private getAdapterSessionId(record: SessionRecord): string {
    return record.adapterSessionId ?? record.id;
  }

  async stopSession(
    sessionId: string,
    reason = 'User requested stop',
    force = false,
  ): Promise<void> {
    const record = this.registry.getOrThrow(sessionId);
    const adapterSid = this.getAdapterSessionId(record);
    await record.adapter.abortSession(adapterSid, reason, force);
    this.registry.updateState(sessionId, 'cancelled');
  }

  async sendInput(sessionId: string, input: string): Promise<void> {
    const record = this.registry.getOrThrow(sessionId);
    const adapterSid = this.getAdapterSessionId(record);
    await record.adapter.sendInput(adapterSid, input);
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const record = this.registry.getOrThrow(sessionId);
    const adapterSid = this.getAdapterSessionId(record);
    await record.adapter.sendMessage(adapterSid, message);
  }

  async submitApproval(
    sessionId: string,
    approvalId: string,
    approved: boolean,
    reason?: string,
  ): Promise<void> {
    const record = this.registry.getOrThrow(sessionId);
    const adapterSid = this.getAdapterSessionId(record);
    await record.adapter.submitApprovalDecision(adapterSid, approvalId, approved, reason);
    this.publishEnvelope(
      sessionId,
      approved ? 'session.approval_granted' : 'session.approval_denied',
      {
        approvalId,
        decision: approved ? 'granted' : 'denied',
        decidedAt: new Date(),
        decidedBy: 'user',
        reason,
      },
    );
  }

  async collectSessionDiff(sessionId: string): Promise<string> {
    const record = this.registry.getOrThrow(sessionId);
    const adapterSid = this.getAdapterSessionId(record);
    try {
      return await record.adapter.collectDiff(adapterSid);
    } catch {
      // Adapter session may have been cleaned up after completion
      return `diff --git a/session-summary.md b/session-summary.md\n# Session ${sessionId}\n# State: ${record.state}\n# Adapter: ${record.adapter.metadata().id}\n`;
    }
  }

  async cleanupSession(sessionId: string): Promise<void> {
    const record = this.registry.get(sessionId);
    if (!record) return;
    try {
      const adapterSid = this.getAdapterSessionId(record);
      await record.adapter.cleanupSession(adapterSid);
    } finally {
      this.registry.delete(sessionId);
    }
  }

  subscribeToEvents(subscriber: EventSubscriber): () => void {
    const unsubBus = this.bus.subscribeGlobal(subscriber);
    const unsub = () => {
      unsubBus();
      this.eventListeners.delete(unsub);
    };
    this.eventListeners.add(unsub);
    return unsub;
  }

  subscribeToSessionEvents(sessionId: string, subscriber: EventSubscriber): () => void {
    const unsubBus = this.bus.subscribeSession(sessionId, subscriber);
    const unsub = () => {
      unsubBus();
      this.eventListeners.delete(unsub);
    };
    this.eventListeners.add(unsub);
    return unsub;
  }

  onGatewayEvent(listener: (event: GatewayEvent) => void): () => void {
    this.gatewayListeners.add(listener);
    return () => this.gatewayListeners.delete(listener);
  }

  private wireAdapterEvents(
    gatewaySessionId: string,
    adapter: AgentAdapter,
    adapterSessionId?: string,
  ): void {
    const effectiveId = adapterSessionId ?? gatewaySessionId;
    const stream = adapter.streamEvents(effectiveId);
    const wire = async () => {
      try {
        for await (const event of stream) {
          // Session may have been cleaned up; skip if so
          if (!this.registry.get(gatewaySessionId)) break;

          this.registry.appendEvent(gatewaySessionId, event);
          this.bus.publish(event);

          // Track event in checkpoint store and health module
          this.checkpointStore.updateReceivedSequence(gatewaySessionId, event.sequence);
          this.checkpointStore.updateEventTypeOffset(
            gatewaySessionId,
            event.eventType,
            event.sequence,
          );
          this.healthModule.recordEvent();

          if (event.eventType === 'session.status_changed') {
            const payload = event.payload as { state?: string };
            if (payload?.state) {
              // Typed as SessionState[] so the membership check narrows
              // payload.state, rather than validating it and then casting the
              // result away through `any`.
              const validStates: SessionState[] = [
                'initializing',
                'running',
                'waiting_for_approval',
                'paused',
                'completed',
                'failed',
                'cancelled',
                'crashed',
              ];
              const candidate = payload.state as SessionState;
              if (validStates.includes(candidate)) {
                this.registry.updateState(gatewaySessionId, candidate);
              }
            }
          }
          const record = this.registry.get(gatewaySessionId);
          if (record) {
            if (event.eventType === 'session.completed') {
              this.registry.updateState(gatewaySessionId, 'completed');
            } else if (event.eventType === 'session.failed') {
              this.registry.updateState(gatewaySessionId, 'failed');
            } else if (event.eventType === 'session.cancelled') {
              this.registry.updateState(gatewaySessionId, 'cancelled');
            } else if (event.eventType === 'session.crashed') {
              this.registry.updateState(gatewaySessionId, 'crashed');
            } else if (event.eventType === 'session.approval_required') {
              this.registry.updateState(gatewaySessionId, 'waiting_for_approval');
            }
          }
        }
      } catch (err) {
        // Session may have been cleaned up during cleanup; ignore
        if (!this.registry.get(gatewaySessionId)) return;
        this.registry.update(gatewaySessionId, {
          state: 'failed',
          endTime: new Date(),
          error: {
            code: 'EVENT_STREAM_ERROR',
            message: err instanceof Error ? err.message : String(err),
            fatal: false,
            retryable: true,
            stack: err instanceof Error ? err.stack : undefined,
          },
        });
        this.emitGatewayEvent({
          type: 'error',
          timestamp: new Date(),
          payload: err,
        });
      }
    };
    void wire();
  }

  private publishEnvelope(
    sessionId: string,
    eventType: EventEnvelope['eventType'],
    payload: unknown,
  ): void {
    const record = this.registry.get(sessionId);
    const sequence = record?.sequenceNumber ?? 0;
    this.bus.publish({
      eventId: generateEventId(),
      eventType,
      eventVersion: 1,
      sessionId,
      deviceId: this.deviceId,
      sequence,
      occurredAt: new Date(),
      payload,
    });
    if (record) {
      record.sequenceNumber = sequence + 1;
      record.eventCount += 1;
      record.lastEventAt = new Date();
      record.lastEventType = eventType;
    }
  }

  private emitGatewayEvent(event: GatewayEvent): void {
    for (const listener of this.gatewayListeners) {
      try {
        listener(event);
      } catch {
        /* swallow */
      }
    }
  }

  private measureResources(): ResourceUsage {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const loadAvg = os.loadavg();
    const cpus = os.cpus();
    const cpuPercent = Math.min(
      100,
      Math.round(((loadAvg[0] ?? 0) / Math.max(1, cpus.length)) * 100),
    );
    const processList = process;
    const nodeUsage = processList.memoryUsage?.();
    const memoryMb = nodeUsage
      ? Math.round(nodeUsage.rss / 1024 / 1024)
      : Math.round(usedMem / 1024 / 1024);

    return {
      cpuPercent,
      memoryMb,
      memoryTotalMb: Math.round(totalMem / 1024 / 1024),
      memoryUsedMb: Math.round(usedMem / 1024 / 1024),
      activeProcesses: 1,
      diskUsagePercent: 0,
      loadAverage: [...loadAvg],
    };
  }
}

export function createGateway(options?: GatewayOptions): GatewayImpl {
  return new GatewayImpl(options);
}

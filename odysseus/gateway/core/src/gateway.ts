import * as os from 'node:os';

import { type CheckpointStore, createCheckpointStore } from '@odysseus/checkpoint';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS, mergeGatewayOptions } from '@odysseus/config';
import { type HealthModule, createHealthModule } from '@odysseus/health';
import { createMockAdapter } from '@odysseus/mock-adapter';
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
} from '@odysseus/protocol';
import {
  generateGatewayId,
  generateDeviceId,
  generateSessionId,
  generateEventId,
  GATEWAY_VERSION,
  DEFAULT_GATEWAY_FEATURES,
} from '@odysseus/protocol';
import {
  type RedactionProxy,
  createRedactionProxy,
  createRedactor,
  DefaultClassifier,
} from '@odysseus/redaction';
import { type TunnelClient, createTunnelClient } from '@odysseus/tunnel';

import { type AgentManager, createAgentManager } from './agent-manager';
import { type EventBus, createEventBus } from './event-bus';
import { collectDiff, commit, createBranch, getStatus, push } from './git/git-operations';
import { runProjectTests } from './git/test-runner';
import { type ProjectManager, createProjectManager } from './project-manager';
import { type AdmissionPhase, ADMISSION_POLICY, SessionAdmissionError } from './runtime/admission';
import {
  AdapterCircuit,
  AdapterUnavailableError,
  CapabilityError,
  findCapabilityViolations,
  requirementsForSession,
} from './runtime/capabilities';
import {
  type SessionRegistry,
  createSessionRegistry,
  type SessionRecord,
} from './session-registry';

export type { GatewayOptions } from '@odysseus/protocol';

export interface GatewayModules {
  checkpointStore: CheckpointStore;
  healthModule: HealthModule;
  tunnelClient: TunnelClient;
  redactionProxy: RedactionProxy;
}

/**
 * What the gateway needs from the integrations manager. Declared here rather
 * than imported so gateway-core does not depend on the integrations package;
 * `@odysseus/integrations` IntegrationManager satisfies it.
 */
export interface IntegrationCommandHandler {
  receiveRequest(payload: unknown): Promise<unknown>;
  revoke(integration: unknown, by: 'web' | 'workstation'): Promise<boolean>;
  list(): Promise<unknown>;
  /** Rescan titles/metadata (and usage, if granted) for an integration. */
  sync?(payload: unknown): Promise<unknown>;
  /** Send one conversation's content, identified by id only. */
  syncContent?(payload: unknown): Promise<unknown>;
  /** Pause/resume local reads when the signed-in website leaves/returns. */
  setClientPresence?(active: boolean, clients: number): Promise<void> | void;
  /** Local signed-grant check before a remote session can spawn a CLI. */
  authorizeSession?(adapterId: string): Promise<void>;
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
  private readonly redactionProxy: RedactionProxy;
  private shuttingDown = false;
  private totalSessionsEver = 0;
  private eventForwardUnsubscribe: (() => void) | null = null;
  private tunnelForwardFailures = 0;
  private admissionPhase: AdmissionPhase = 'running';
  private readonly phaseListeners: Set<(phase: AdmissionPhase) => void> = new Set();
  private readonly adapterCircuits = new Map<string, AdapterCircuit>();

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
    const cp = this.options.controlPlane;
    this.tunnelClient = createTunnelClient({
      controlPlaneUrl: cp?.url ?? '',
      deviceId: this.deviceId,
      gatewayId: this.gatewayId,
      ...(cp?.authToken ? { authToken: cp.authToken } : {}),
      ...(cp?.heartbeatIntervalMs ? { heartbeatIntervalMs: cp.heartbeatIntervalMs } : {}),
      ...(cp?.reconnectBaseMs ? { reconnectBaseMs: cp.reconnectBaseMs } : {}),
      ...(cp?.reconnectMaxMs ? { reconnectMaxMs: cp.reconnectMaxMs } : {}),
      ...(cp?.maxReconnectAttempts !== undefined
        ? { maxReconnectAttempts: cp.maxReconnectAttempts }
        : {}),
    });
    this.tunnelClient.setCommandHandler({
      handleCommand: (command) => this.handleTunnelCommand(command),
    });

    // Heartbeats carry the admission phase and live load, so the Control
    // Plane's router can stop selecting a draining gateway within one beat
    // rather than discovering it through a failed command.
    this.tunnelClient.setHeartbeatContributor(() => {
      const resources = this.measureResources();
      return {
        admissionPhase: this.admissionPhase,
        load: {
          activeSessions: this.registry.getActiveCount(),
          pendingApprovals: 0,
          cpuPercent: resources.cpuPercent,
          memoryMb: resources.memoryMb,
        },
        systemInfo: {
          hostname: os.hostname().slice(0, 120),
          platform:
            os.platform() === 'win32'
              ? 'windows'
              : os.platform() === 'darwin'
                ? 'darwin'
                : os.platform() === 'linux'
                  ? 'linux'
                  : 'unknown',
          arch: os.arch(),
          nodeVersion: process.version,
          gatewayVersion: GATEWAY_VERSION,
        },
      };
    });

    // Forward every locally-published event up the tunnel. Without this bridge
    // the Control Plane sees a session start and then total silence — the
    // browser renders a "running" session with an empty console forever.
    this.eventForwardUnsubscribe = this.bus.subscribeGlobal({
      onEvent: (envelope: EventEnvelope) => {
        this.forwardEnvelopeToTunnel(envelope);
      },
    });

    // Wire up redaction proxy
    this.redactionProxy = createRedactionProxy(
      createRedactor({
        ...(this.options.redaction.customPatterns
          ? {
              customPatterns: this.options.redaction.customPatterns.map((p) => ({
                name: p.name,
                type: 'custom',
                pattern: new RegExp(p.pattern, 'gi'),
                ...(p.replacement ? { placeholder: p.replacement } : {}),
              })),
            }
          : {}),
      }),
      new DefaultClassifier(),
      { enabled: this.options.redaction.enabled },
    );

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
        : this.options.controlPlane?.url
          ? 'Tunnel configured but not connected'
          : 'Tunnel disabled (no controlPlane.url configured)',
      lastCheckedAt: new Date(),
      durationMs: 0,
      metrics: { ...this.tunnelClient.getStats() } as unknown as Record<string, unknown>,
    }));

    this.healthModule.registerCheck('redaction-proxy', () => ({
      name: 'redaction-proxy',
      status: 'healthy',
      message: 'Redaction active',
      lastCheckedAt: new Date(),
      durationMs: 0,
      metrics: { ...this.redactionProxy.getStats() } as unknown as Record<string, unknown>,
    }));

    // The mock adapter is always available as a fallback unless an explicit
    // allowlist excludes it. Real adapters are registered by the composition
    // root via registerAdapter() so core does not depend on every vendor.
    if (this.isAdapterAllowed('mock')) {
      this.agents.register(createMockAdapter());
    }

    this.emitGatewayEvent({ type: 'gateway.started', timestamp: new Date() });
  }

  private circuitFor(adapterId: string): AdapterCircuit {
    let circuit = this.adapterCircuits.get(adapterId);
    if (!circuit) {
      circuit = new AdapterCircuit();
      this.adapterCircuits.set(adapterId, circuit);
    }
    return circuit;
  }

  /** Circuit state per adapter, for health reporting and diagnostics. */
  getAdapterCircuits(): Record<string, ReturnType<AdapterCircuit['snapshot']>> {
    return Object.fromEntries(
      Array.from(this.adapterCircuits.entries()).map(([id, circuit]) => [id, circuit.snapshot()]),
    );
  }

  /**
   * Agent inventory with circuit state folded into health.
   *
   * AgentRouter already filters on `health.status !== 'unhealthy'`, so an open
   * circuit removes the adapter from fleet routing with no extra plumbing.
   */
  async listAgentsWithCircuitHealth(): Promise<AgentInfo[]> {
    const agents = await this.listAgents();
    return agents.map((agent) => {
      const circuit = this.adapterCircuits.get(agent.metadata.id);
      if (!circuit) return agent;

      const snapshot = circuit.snapshot();
      if (snapshot.state === 'closed') return agent;

      return {
        ...agent,
        health: {
          ...agent.health,
          status: snapshot.state === 'open' ? 'unhealthy' : 'degraded',
          issues: [
            ...(agent.health.issues ?? []),
            `Circuit ${snapshot.state} after ${snapshot.consecutiveFailures} consecutive ` +
              `failures${snapshot.lastError ? `: ${snapshot.lastError}` : ''}`,
          ],
        },
      };
    });
  }

  /** True when no allowlist is configured, or the id appears in it. */
  private isAdapterAllowed(adapterId: string): boolean {
    const allowed = this.options.allowedAdapters;
    if (!allowed || allowed.length === 0) return true;
    return allowed.includes(adapterId);
  }

  /**
   * Register a real agent adapter. Called by the composition root (the gateway
   * entrypoint) rather than by core itself, so that adding a vendor never
   * means adding a dependency to @odysseus/gateway-core.
   *
   * Returns false when an allowlist is configured and excludes this adapter.
   */
  registerAdapter(adapter: AgentAdapter): boolean {
    const id = adapter.metadata().id;
    if (!this.isAdapterAllowed(id)) return false;
    this.agents.register(adapter);
    this.emitGatewayEvent({
      type: 'agent.detected',
      timestamp: new Date(),
      payload: { adapterId: id },
    });
    return true;
  }

  /**
   * Redact, then push one event envelope up the tunnel. Failures are counted
   * and swallowed: a tunnel problem must never break local session execution,
   * and TunnelClient already queues and replays whatever cannot go out now.
   */
  private forwardEnvelopeToTunnel(envelope: EventEnvelope): void {
    if (!this.options.controlPlane?.url) return;
    try {
      const safe = this.redactionProxy.redactEvent(envelope);
      this.tunnelClient.send('event', { event: safe });
    } catch (err) {
      this.tunnelForwardFailures++;
      this.emitGatewayEvent({
        type: 'error',
        timestamp: new Date(),
        payload: {
          scope: 'tunnel.forward',
          sessionId: envelope.sessionId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  /**
   * Dial the Control Plane. The caller supplies the WebSocket implementation
   * and the signing identity, keeping node-specific and key-handling concerns
   * out of core.
   */
  async connectToControlPlane(deps: {
    webSocketImpl: Parameters<TunnelClient['setWebSocketImplementation']>[0];
    authProvider: Parameters<TunnelClient['setAuthProvider']>[0];
  }): Promise<void> {
    if (!this.options.controlPlane?.url) {
      throw new Error(
        'controlPlane.url is not configured; pass it in GatewayOptions to enable the tunnel',
      );
    }
    this.tunnelClient.setWebSocketImplementation(deps.webSocketImpl);
    this.tunnelClient.setAuthProvider(deps.authProvider);
    await this.tunnelClient.connect();
  }

  isTunnelConnected(): boolean {
    return this.tunnelClient.isConnected();
  }

  getTunnelStats(): ReturnType<TunnelClient['getStats']> & { forwardFailures: number } {
    return { ...this.tunnelClient.getStats(), forwardFailures: this.tunnelForwardFailures };
  }

  // ------------------------------------------------------------- admission

  getAdmissionPhase(): AdmissionPhase {
    return this.admissionPhase;
  }

  /** Subscribe to phase transitions. Returns an unsubscribe function. */
  onAdmissionPhaseChange(listener: (phase: AdmissionPhase) => void): () => void {
    this.phaseListeners.add(listener);
    return () => this.phaseListeners.delete(listener);
  }

  private setAdmissionPhase(phase: AdmissionPhase): void {
    if (this.admissionPhase === phase) return;
    this.admissionPhase = phase;

    // Announce out-of-band rather than waiting up to a full heartbeat
    // interval. Until the Control Plane knows, its router keeps sending work
    // to a gateway that is going to refuse it.
    try {
      this.tunnelClient.sendImmediateHeartbeat();
    } catch {
      /* the regular heartbeat will carry it */
    }

    for (const listener of this.phaseListeners) {
      try {
        listener(phase);
      } catch {
        /* a listener must not break the lifecycle */
      }
    }
  }

  /** Sessions that are still doing work, i.e. would be lost by an abort now. */
  getActiveSessionCount(): number {
    return this.registry.listByState(['initializing', 'running', 'waiting_for_approval', 'paused'])
      .length;
  }

  /**
   * Stop accepting new sessions and wait for in-flight ones to finish.
   *
   * The tunnel deliberately stays open for the whole drain so the terminal
   * events of each finishing session still reach the Control Plane. Returns
   * once everything has finished or the budget expires — the caller decides
   * whether to escalate to an abort.
   */
  async drain(
    budgetMs = 120_000,
    pollIntervalMs = 250,
  ): Promise<{ drained: boolean; remaining: number; waitedMs: number }> {
    this.setAdmissionPhase('draining');
    const startedAt = Date.now();
    const deadline = startedAt + budgetMs;

    while (Date.now() < deadline) {
      const remaining = this.getActiveSessionCount();
      if (remaining === 0) {
        return { drained: true, remaining: 0, waitedMs: Date.now() - startedAt };
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    return {
      drained: this.getActiveSessionCount() === 0,
      remaining: this.getActiveSessionCount(),
      waitedMs: Date.now() - startedAt,
    };
  }

  /** Move to `aborting`: in-flight sessions are cancelled, tunnel stays open. */
  beginAborting(): void {
    this.setAdmissionPhase('aborting');
  }

  /**
   * Get access to the gateway's internal modules.
   */
  getModules(): GatewayModules {
    return {
      checkpointStore: this.checkpointStore,
      healthModule: this.healthModule,
      tunnelClient: this.tunnelClient,
      redactionProxy: this.redactionProxy,
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

  private integrationHandler: IntegrationCommandHandler | undefined;

  /**
   * Enable integration commands. Without a handler they are refused: the
   * gateway never touches integration data unless the process that owns the
   * device key has set up the consent-checking manager.
   */
  setIntegrationHandler(handler: IntegrationCommandHandler | undefined): void {
    this.integrationHandler = handler;
  }

  private async handleTunnelCommand(
    command: unknown,
  ): Promise<{ success: boolean; result?: unknown; error?: string }> {
    const value = command as { commandType?: unknown; payload?: unknown };
    const commandType = typeof value?.commandType === 'string' ? value.commandType : '';
    const payload =
      typeof value?.payload === 'object' && value.payload !== null
        ? (value.payload as Record<string, unknown>)
        : {};
    const sessionId = typeof payload['sessionId'] === 'string' ? payload['sessionId'] : undefined;
    try {
      switch (commandType) {
        case 'client.presence': {
          const handler = this.integrationHandler;
          if (!handler?.setClientPresence) {
            return { success: false, error: 'Integrations are not enabled on this gateway' };
          }
          const clients =
            typeof payload['clients'] === 'number' && payload['clients'] >= 0
              ? Math.floor(payload['clients'])
              : 0;
          return {
            success: true,
            result: await handler.setClientPresence(payload['active'] === true, clients),
          };
        }
        // The Control Plane may ask for access and may revoke it. There is no
        // command that approves: approval only happens at this machine.
        case 'integration.sync':
        case 'integration.sync_content': {
          const handler = this.integrationHandler;
          // Picked by name and invoked below with .call(handler, …), so the
          // receiver is never lost — which is what the rule guards against.
          // eslint-disable-next-line @typescript-eslint/unbound-method
          const run = commandType === 'integration.sync' ? handler?.sync : handler?.syncContent;
          if (!handler || !run) {
            return { success: false, error: 'Integrations are not enabled on this gateway' };
          }
          return { success: true, result: await run.call(handler, payload) };
        }
        case 'integration.grant_request':
        case 'integration.revoke':
        case 'integration.list': {
          const handler = this.integrationHandler;
          if (!handler) {
            return { success: false, error: 'Integrations are not enabled on this gateway' };
          }
          if (commandType === 'integration.grant_request') {
            return { success: true, result: await handler.receiveRequest(payload) };
          }
          if (commandType === 'integration.revoke') {
            return {
              success: true,
              result: { revoked: await handler.revoke(payload['integration'], 'web') },
            };
          }
          return { success: true, result: await handler.list() };
        }
        case 'session.start': {
          const config = payload['config'] as SessionConfig;
          return { success: true, result: await this.createSession(config) };
        }
        case 'session.stop':
          if (!sessionId) throw new Error('sessionId is required');
          await this.stopSession(
            sessionId,
            String(payload['reason'] ?? 'Control Plane request'),
            Boolean(payload['force']),
          );
          return { success: true };
        case 'session.message':
          if (!sessionId || typeof payload['message'] !== 'string')
            throw new Error('sessionId and message are required');
          await this.sendMessage(sessionId, payload['message']);
          return { success: true };
        case 'session.diff_collection': {
          const root = this.commandProjectRoot(payload);
          return { success: true, result: { diff: await collectDiff(root) } };
        }
        case 'session.run_tests':
          return { success: true, result: await runProjectTests(this.commandProjectRoot(payload)) };
        case 'system.inventory':
          return {
            success: true,
            result: {
              gatewayId: this.gatewayId,
              deviceId: this.deviceId,
              // Circuit state is folded into health here, so an adapter that
              // keeps failing drops out of the Control Plane's routing.
              agents: await this.listAgentsWithCircuitHealth(),
              activeSessions: this.registry.getActiveCount(),
              admissionPhase: this.admissionPhase,
            },
          };
        case 'git.branch_create': {
          const root = this.commandProjectRoot(payload);
          const branch = this.requiredString(payload, 'branch');
          const fromRef = typeof payload['fromRef'] === 'string' ? payload['fromRef'] : undefined;
          return { success: true, result: await createBranch(root, branch, fromRef) };
        }
        case 'git.commit': {
          const root = this.commandProjectRoot(payload);
          const files = Array.isArray(payload['files'])
            ? payload['files'].filter((item): item is string => typeof item === 'string')
            : undefined;
          return {
            success: true,
            result: await commit(root, this.requiredString(payload, 'message'), files),
          };
        }
        case 'git.push':
          return {
            success: true,
            result: await push(
              this.commandProjectRoot(payload),
              this.requiredString(payload, 'branch'),
              typeof payload['remote'] === 'string' ? payload['remote'] : 'origin',
              Boolean(payload['force']),
            ),
          };
        case 'git.status':
          return { success: true, result: await getStatus(this.commandProjectRoot(payload)) };
        default:
          return { success: false, error: `Unsupported command: ${commandType || '(missing)'}` };
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private commandProjectRoot(payload: Record<string, unknown>): string {
    return this.requiredString(payload, 'projectRoot');
  }

  private requiredString(payload: Record<string, unknown>, field: string): string {
    const value = payload[field];
    if (typeof value !== 'string' || !value) throw new Error(`${field} is required`);
    return value;
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
    // A direct shutdown() without a preceding drain() still has to close
    // admission, or a session could be accepted while teardown is running.
    this.setAdmissionPhase(graceful ? 'draining' : 'aborting');

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

    // Stop forwarding before the tunnel goes down so late events do not queue
    // up in a client that is about to be torn down.
    if (this.eventForwardUnsubscribe) {
      this.eventForwardUnsubscribe();
      this.eventForwardUnsubscribe = null;
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
    this.setAdmissionPhase('stopped');
    for (const unsub of this.eventListeners) unsub();
    this.eventListeners.clear();
    this.gatewayListeners.clear();
    this.phaseListeners.clear();
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
    // Admission is checked before anything else. A session refused because the
    // gateway is draining is a different thing from one that failed, and the
    // Control Plane needs to tell them apart to answer 503 vs 500.
    if (!ADMISSION_POLICY[this.admissionPhase].acceptsNewSessions) {
      throw new SessionAdmissionError(this.admissionPhase);
    }
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

    await this.integrationHandler?.authorizeSession?.(config.adapter);

    // An adapter whose CLI is broken is not retried on every session. The open
    // circuit also makes it report unhealthy, which drops it out of fleet
    // routing via system.inventory.
    const circuit = this.circuitFor(config.adapter);
    if (!circuit.allowsAttempt()) {
      throw new AdapterUnavailableError(config.adapter, circuit.snapshot());
    }

    // Capabilities are enforced BEFORE anything is spawned. Starting a session
    // that asks for approvals against an adapter that cannot intercept them
    // produces a session that looks governed and is not.
    const violations = findCapabilityViolations(
      adapter.metadata().capabilities,
      requirementsForSession(config),
    );
    if (violations.length > 0) {
      throw new CapabilityError(config.adapter, violations);
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

    // When the Control Plane originates a session it has already minted and
    // persisted an id, and it queries events back by that id. Minting a second
    // id here splits the session in two: events get stored under the gateway's
    // id while /sessions/:id/events asks for the Control Plane's, so the live
    // console stays empty. Honour a caller-supplied id when there is one.
    const requestedSessionId = config.metadata?.['sessionId'];
    const gatewaySessionId =
      typeof requestedSessionId === 'string' && requestedSessionId
        ? requestedSessionId
        : generateSessionId();
    let adapterSessionId: string;

    try {
      // Start the adapter session first to get its session ID
      adapterSessionId = await adapter.startSession(config);
      circuit.recordSuccess();
    } catch (err) {
      circuit.recordFailure(err);
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
        for await (let event of stream) {
          // Session may have been cleaned up; skip if so
          if (!this.registry.get(gatewaySessionId)) break;

          // Redact event before it reaches storage or transmission
          event = this.redactionProxy.redactEvent(event);

          // Adapters label events with their OWN session id. Publishing that
          // verbatim sends the Control Plane events keyed to a session it has
          // no record of, so they are stored but never returned by
          // /sessions/:id/events and the live console stays empty. Re-key every
          // adapter event onto the gateway/Control Plane session id.
          if (event.sessionId !== gatewaySessionId) {
            event = { ...event, sessionId: gatewaySessionId };
          }
          if (!event.deviceId) {
            event = { ...event, deviceId: this.deviceId };
          }

          // Re-number onto the gateway's single per-session counter. The
          // adapter's own numbering is private to the adapter and overlaps
          // with events the gateway publishes itself.
          event = { ...event, sequence: this.nextSequence(gatewaySessionId) };

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

  /**
   * The next sequence number for a session.
   *
   * There is exactly one counter per session and it lives here. Adapters keep
   * their own counters starting at zero, and the gateway used to publish its
   * own events (session.created) on a separate counter also starting at zero —
   * so two different events in one session could share a sequence. That breaks
   * gap detection during reconciliation, and makes any dedup keyed on
   * (sessionId, sequence) silently drop a real event.
   */
  private nextSequence(sessionId: string): number {
    const record = this.registry.get(sessionId);
    if (!record) return 0;
    const sequence = record.sequenceNumber;
    record.sequenceNumber = sequence + 1;
    return sequence;
  }

  private publishEnvelope(
    sessionId: string,
    eventType: EventEnvelope['eventType'],
    payload: unknown,
  ): void {
    const record = this.registry.get(sessionId);
    const sequence = this.nextSequence(sessionId);
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

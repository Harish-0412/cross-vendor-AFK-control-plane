import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { UsageAlert } from '@odysseus/protocol';

import { AfkOrchestrator } from './afk/afk-orchestrator';
import { EscalationScheduler } from './afk/escalation-scheduler';
import { notificationForUsageAlert } from './afk/notification-templates';
import { PushSender } from './afk/push-sender';
import { HttpRouter } from './api/http-router';
import { getFirebaseFirestore, isFirebaseAdminConfigured } from './auth/firebase-admin';
import { loadConfig, isAllowedOrigin } from './config';
import { FirestoreDatabase } from './db/firestore-store';
import { MemoryDatabase } from './db/memory-store';
import type { IDatabase } from './db/types';
import { HistoryIngest } from './integrations/history-ingest';
import { IntegrationAccessService } from './integrations/integration-access';
import { AgentRouter } from './orchestration/agent-router';
import { ContextAgent } from './orchestration/context-agent';
import { CostGovernor } from './orchestration/cost-governor';
import { MultiAgentOrchestrator } from './orchestration/multi-agent-orchestrator';
import { RiskEngine } from './orchestration/risk-engine';
import { PolicyEngineService, ApprovalWorkflow, AuditLog } from './policy/index';
import { ReviewOrchestrator } from './review/review-orchestrator';
import { ClientServer } from './tunnel/client-server';
import { ConnectionRegistry } from './tunnel/connection-registry';
import { TunnelServer } from './tunnel/tunnel-server';
import type { ControlPlaneConfig, StoredEvent } from './types';

export class ControlPlane {
  public db: IDatabase;
  public registry: ConnectionRegistry;
  public tunnelServer: TunnelServer;
  public clientServer: ClientServer;
  public router: HttpRouter;
  public config: ControlPlaneConfig;
  public policyService: PolicyEngineService;
  public approvalWorkflow: ApprovalWorkflow;
  public auditLog: AuditLog;
  public pushSender: PushSender;
  public afkOrchestrator: AfkOrchestrator;
  public escalationScheduler: EscalationScheduler;
  public reviewOrchestrator: ReviewOrchestrator;
  public agentRouter: AgentRouter;
  public costGovernor: CostGovernor;
  public riskEngine: RiskEngine;
  public multiAgentOrchestrator: MultiAgentOrchestrator;
  public integrationAccess: IntegrationAccessService;
  /**
   * True when no persistent database was configured. The production guard
   * refuses to start on this, because a container restart would erase every
   * user, pairing and audit record.
   */
  public readonly usingMemoryDatabase: boolean;
  private server?: http.Server | undefined;
  private actualPort = 0;

  constructor(options: Partial<ControlPlaneConfig> = {}, db?: IDatabase) {
    this.config = loadConfig(options);
    if (db) {
      this.db = db;
    } else if (process.env.USE_FIRESTORE === 'true' || isFirebaseAdminConfigured()) {
      const firestore = getFirebaseFirestore();
      if (firestore) {
        // eslint-disable-next-line no-console
        console.info('[Odysseus Control Plane] Using Cloud Firestore as persistent database');
        this.db = new FirestoreDatabase(firestore);
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          '[Odysseus Control Plane] Firestore requested but could not be initialized, falling back to MemoryDatabase. ' +
            'Credentials are read from GOOGLE_APPLICATION_CREDENTIALS (a path to the service-account JSON' +
            (process.env.GOOGLE_APPLICATION_CREDENTIALS
              ? `; set to ${process.env.GOOGLE_APPLICATION_CREDENTIALS}, which does not exist or failed to load`
              : '; not set') +
            ') or from FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY' +
            (process.env.FIREBASE_PRIVATE_KEY ? '' : ' (FIREBASE_PRIVATE_KEY not set)') +
            '.',
        );
        this.db = new MemoryDatabase();
      }
    } else {
      this.db = new MemoryDatabase();
    }
    this.usingMemoryDatabase = this.db instanceof MemoryDatabase;
    this.registry = new ConnectionRegistry();

    this.tunnelServer = new TunnelServer(this.db, this.registry, {
      heartbeatTimeoutMs: this.config.heartbeatTimeoutMs,
    });

    this.clientServer = new ClientServer(this.registry, this.config.jwtSecret, this.db);

    this.pushSender = new PushSender(this.db);
    this.afkOrchestrator = new AfkOrchestrator(this.db, this.registry, this.pushSender);
    this.escalationScheduler = new EscalationScheduler(this.db, this.pushSender);
    this.tunnelServer.setOnApprovalCreated((approval) => {
      void this.escalationScheduler.schedule(approval).catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[Odysseus Control Plane] Approval escalation scheduling failed:', error);
      });
    });

    // Policy Engine (Phase 5)
    this.auditLog = new AuditLog(this.db);
    this.policyService = new PolicyEngineService(this.db, this.config, this.auditLog);
    this.approvalWorkflow = new ApprovalWorkflow(this.db, this.tunnelServer); // §7.4 — TunnelServer injected for feedback dispatch
    this.approvalWorkflow.setOnApprovalCreated((approval) =>
      this.escalationScheduler.schedule(approval),
    );
    this.reviewOrchestrator = new ReviewOrchestrator(
      this.db,
      this.tunnelServer,
      this.policyService,
    );
    this.riskEngine = new RiskEngine();
    this.costGovernor = new CostGovernor(this.db);
    this.agentRouter = new AgentRouter(this.db, this.registry, this.tunnelServer);
    this.multiAgentOrchestrator = new MultiAgentOrchestrator(
      this.db,
      this.tunnelServer,
      this.policyService,
      this.approvalWorkflow,
      this.agentRouter,
      this.riskEngine,
      this.costGovernor,
      { context: new ContextAgent(this.db) },
    );

    // Wire real-time event forwarding and the automatic completion review.
    this.tunnelServer.setOnEventBroadcast((storedEvent) => {
      this.clientServer.broadcastEvent(storedEvent);
      // A finished session may be an orchestration step; its run moves on now
      // rather than when someone next presses "advance".
      if (endsSession(storedEvent)) {
        void this.multiAgentOrchestrator
          .onSessionFinished(storedEvent.sessionId)
          .catch((error: unknown) =>
            console.warn('[Odysseus Control Plane] Orchestration advance failed:', error),
          );
      }
      void this.afkOrchestrator.handleEvent(storedEvent).catch((error: unknown) => {
        console.warn('[Odysseus Control Plane] AFK notification pipeline failed:', error);
      });
      if (storedEvent.eventType === 'session.completed') {
        void this.reviewOrchestrator.build(storedEvent.sessionId).catch((error: unknown) => {
          console.warn('[Odysseus Control Plane] Review bundle generation failed:', error);
        });
        const payload = storedEvent.envelope.payload as {
          metrics?: { totalTokens?: unknown; costUsd?: unknown };
        };
        const tokens = payload?.metrics?.totalTokens;
        const costUsd = payload?.metrics?.costUsd;
        if (typeof tokens === 'number' && Number.isFinite(tokens)) {
          void this.db.sessions
            .findById(storedEvent.sessionId)
            .then((session) => {
              if (!session) return;
              return this.costGovernor.recordUsage({
                sessionId: session.id,
                userId: session.userId,
                ...(session.projectId ? { projectId: session.projectId } : {}),
                ...(session.organizationId ? { organizationId: session.organizationId } : {}),
                tokens,
                costUsd: typeof costUsd === 'number' && Number.isFinite(costUsd) ? costUsd : 0,
              });
            })
            .catch((error: unknown) =>
              console.warn('[Odysseus Control Plane] Cost recording failed:', error),
            );
        }
      }
    });

    // Wire policy evaluator into tunnel server (§7.2)
    this.tunnelServer.setPolicyEvaluator((capability, riskClass, context, _policyVersion) => {
      return this.policyService.evaluate(capability, riskClass, {
        ...(context.resource ? { resource: context.resource } : {}),
        ...(context.projectId ? { projectId: context.projectId } : {}),
        deviceId: context.deviceId,
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        userId: context.userId,
      });
    });

    this.router = new HttpRouter(
      this.db,
      this.registry,
      this.tunnelServer,
      this.config,
      this.policyService,
      this.approvalWorkflow,
      this.auditLog,
      this.reviewOrchestrator,
      this.agentRouter,
      this.riskEngine,
      this.costGovernor,
      this.multiAgentOrchestrator,
    );

    this.integrationAccess = new IntegrationAccessService(
      this.db,
      this.tunnelServer,
      this.auditLog,
      (userId, message) => this.clientServer.sendToUser(userId, message),
      new HistoryIngest(this.db, this.costGovernor, (userId, alert) =>
        this.announceUsageAlert(userId, alert),
      ),
    );
    this.router.setIntegrationAccess(this.integrationAccess);
    this.tunnelServer.setOnIntegrationUpdate((deviceId, payload) => {
      void this.integrationAccess.handleGatewayUpdate(deviceId, payload).catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[Odysseus Control Plane] Integration update failed:', error);
      });
    });
    this.tunnelServer.setOnGatewayAuthenticated((deviceId) => {
      void this.integrationAccess.deliverPendingRevokes(deviceId).catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[Odysseus Control Plane] Delivering pending revokes failed:', error);
      });
      void (async () => {
        const device = await this.db.devices.findById(deviceId);
        if (!device) return;
        const clients = this.registry.getClientsForUser(device.userId).length;
        await this.tunnelServer.sendCommandToDevice(
          deviceId,
          'client.presence',
          { active: clients > 0, clients },
          5_000,
          false,
        );
      })().catch((error: unknown) => {
        console.warn('[Odysseus Control Plane] Initial presence delivery failed:', error);
      });
    });

    // Local history readers run only while at least one authenticated website
    // or mobile client is live. Multiple tabs count as one presence state;
    // closing the final one pauses reads immediately on every paired gateway.
    this.clientServer.setOnPresenceChange(async (userId, clients) => {
      const devices = await this.db.devices.listByUser(userId);
      await Promise.all(
        devices.map((device) =>
          this.tunnelServer.sendCommandToDevice(
            device.id,
            'client.presence',
            { active: clients > 0, clients },
            5_000,
            false,
          ),
        ),
      );
    });

    this.tunnelServer.setOnClientControl((deviceId, payload) => {
      if (payload['action'] !== 'terminate_all') return;
      void (async () => {
        const device = await this.db.devices.findById(deviceId);
        if (!device) return;
        this.clientServer.disconnectUser(
          device.userId,
          typeof payload['reason'] === 'string'
            ? payload['reason']
            : 'Disconnected from the workstation',
        );
      })().catch((error: unknown) => {
        console.warn('[Odysseus Control Plane] Workstation disconnect failed:', error);
      });
    });
  }

  /**
   * Tell the user a plan limit is nearly spent, on whatever is listening.
   *
   * Both paths are attempted: the open website gets it immediately, and the
   * phone gets it even with nothing open — which is the case that matters,
   * since the whole point is to hear about it while away from the desk. A
   * failure to push must never fail the sync that produced the reading, so it
   * is logged and swallowed.
   */
  private async announceUsageAlert(userId: string, alert: UsageAlert): Promise<void> {
    this.clientServer.sendToUser(userId, { type: 'usage_alert', alert });
    try {
      await this.pushSender.sendToUser(userId, notificationForUsageAlert(alert));
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[Odysseus Control Plane] Usage alert push failed:', error);
    }
  }

  async start(): Promise<{ url: string; port: number }> {
    if (this.server) {
      return { url: this.getUrl(), port: this.actualPort };
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        logAccess(req, res);
        void this.router.handleRequest(req, res).catch((error: unknown) => {
          // Previously swallowed silently: a route that threw returned a 500
          // and left no trace, so a production failure was invisible in the
          // logs. The request line is enough to find it; no body is logged.
          // eslint-disable-next-line no-console
          console.error(
            `[Odysseus Control Plane] Unhandled error on ${req.method ?? '?'} ${pathOf(req)}:`,
            error,
          );
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal Server Error' }));
          }
        });
      });

      // WebSocket Upgrade Routing
      this.server.on('upgrade', (req, socket, head) => {
        const host = req.headers.host || 'localhost';
        const url = new URL(req.url || '/', `http://${host}`);
        const path = url.pathname;

        if (path.startsWith('/ws/tunnel') || path === '/tunnel') {
          // No Origin check for the gateway tunnel: it is not a browser, it
          // sends no Origin, and its identity is proven by the signed
          // handshake instead.
          this.tunnelServer.handleUpgrade(req, socket, head);
        } else if (
          path.startsWith('/ws/client') ||
          path.startsWith('/ws/events') ||
          path === '/client'
        ) {
          if (!this.isAllowedWebSocketOrigin(req.headers.origin)) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
          }
          this.clientServer.handleUpgrade(req, socket, head);
        } else {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
          socket.destroy();
        }
      });

      this.server.on('error', reject);

      this.server.listen(this.config.port, this.config.host, () => {
        const addr = this.server?.address() as AddressInfo;
        this.actualPort = addr.port;
        void this.escalationScheduler.reconcile().catch((error: unknown) => {
          // eslint-disable-next-line no-console
          console.warn(
            '[Odysseus Control Plane] Approval escalation reconciliation failed:',
            error,
          );
        });
        resolve({ url: this.getUrl(), port: this.actualPort });
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    this.tunnelServer.close();
    this.clientServer.close();
    this.escalationScheduler.close();

    await new Promise<void>((resolve, reject) => {
      this.server?.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    delete this.server;
  }

  getUrl(): string {
    const host = this.config.host === '0.0.0.0' ? 'localhost' : this.config.host;
    return `http://${host}:${this.actualPort || this.config.port}`;
  }

  /**
   * Decide whether a browser WebSocket handshake may proceed.
   *
   * Browsers do not apply CORS to WebSocket upgrades, so the REST allowlist
   * does nothing here. Without this check any page the user visits while
   * logged in could open a socket to the Control Plane and act as them —
   * Cross-Site WebSocket Hijacking.
   *
   * A request with no Origin header is not a browser (curl, a native app, a
   * test) and is allowed through to token authentication, which is the real
   * gate. The Origin check exists to stop *browsers* acting on behalf of
   * another site, and a browser always sends one.
   */
  isAllowedWebSocketOrigin(origin: string | undefined): boolean {
    if (!origin) return true;
    if (this.config.corsOrigins.includes('*')) return true;
    return isAllowedOrigin(origin, this.config.corsOrigins);
  }
  getWsTunnelUrl(): string {
    const host = this.config.host === '0.0.0.0' ? 'localhost' : this.config.host;
    return `ws://${host}:${this.actualPort || this.config.port}/ws/tunnel`;
  }

  getWsClientUrl(): string {
    const host = this.config.host === '0.0.0.0' ? 'localhost' : this.config.host;
    return `ws://${host}:${this.actualPort || this.config.port}/ws/client`;
  }

  getPort(): number {
    return this.actualPort;
  }
}

/** The request path without its query string, which can carry codes. */
function pathOf(req: http.IncomingMessage): string {
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  return q === -1 ? raw : raw.slice(0, q);
}

/**
 * One line per request: method, path, status, duration.
 *
 * Without it the hosted Control Plane recorded nothing about requests, so a
 * failed sign-in left no evidence of whether it even arrived. Deliberately
 * minimal: no query strings, headers, bodies or tokens. Health checks are
 * skipped — the platform polls them constantly and they would drown the rest.
 * Set ACCESS_LOG=false to disable.
 */
function logAccess(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (process.env.ACCESS_LOG === 'false') return;
  const path = pathOf(req);
  if (path === '/health' || path === '/api/v1/health') return;

  const started = process.hrtime.bigint();
  res.once('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    // eslint-disable-next-line no-console
    console.info(`[http] ${req.method ?? '?'} ${path} ${res.statusCode} ${ms.toFixed(0)}ms`);
  });
}

const FINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'crashed']);

/** Whether this event means its session has reached a final state. */
function endsSession(event: StoredEvent): boolean {
  if (
    event.eventType === 'session.completed' ||
    event.eventType === 'session.failed' ||
    event.eventType === 'session.cancelled' ||
    event.eventType === 'session.crashed'
  )
    return true;
  if (event.eventType !== 'session.status_changed') return false;
  const state = (event.envelope.payload as { state?: unknown } | undefined)?.state;
  return typeof state === 'string' && FINAL_STATES.has(state);
}

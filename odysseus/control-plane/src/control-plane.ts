import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { AfkOrchestrator } from './afk/afk-orchestrator';
import { EscalationScheduler } from './afk/escalation-scheduler';
import { PushSender } from './afk/push-sender';
import { HttpRouter } from './api/http-router';
import { getFirebaseFirestore, isFirebaseAdminConfigured } from './auth/firebase-admin';
import { loadConfig } from './config';
import { FirestoreDatabase } from './db/firestore-store';
import { MemoryDatabase } from './db/memory-store';
import type { IDatabase } from './db/types';
import { AgentRouter } from './orchestration/agent-router';
import { CostGovernor } from './orchestration/cost-governor';
import { MultiAgentOrchestrator } from './orchestration/multi-agent-orchestrator';
import { RiskEngine } from './orchestration/risk-engine';
import { PolicyEngineService, ApprovalWorkflow, AuditLog } from './policy/index';
import { ReviewOrchestrator } from './review/review-orchestrator';
import { ClientServer } from './tunnel/client-server';
import { ConnectionRegistry } from './tunnel/connection-registry';
import { TunnelServer } from './tunnel/tunnel-server';
import type { ControlPlaneConfig } from './types';

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
    );

    // Wire real-time event forwarding and the automatic completion review.
    this.tunnelServer.setOnEventBroadcast((storedEvent) => {
      this.clientServer.broadcastEvent(storedEvent);
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
  }

  async start(): Promise<{ url: string; port: number }> {
    if (this.server) {
      return { url: this.getUrl(), port: this.actualPort };
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        void this.router.handleRequest(req, res).catch(() => {
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

    const allowed = this.config.corsOrigins;
    if (allowed.includes('*')) return true;
    return allowed.includes(origin);
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

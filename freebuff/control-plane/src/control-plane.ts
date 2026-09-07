import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { HttpRouter } from './api/http-router';
import { loadConfig } from './config';
import { MemoryDatabase } from './db/memory-store';
import type { IDatabase } from './db/types';
import { ClientServer } from './tunnel/client-server';
import { ConnectionRegistry } from './tunnel/connection-registry';
import { TunnelServer } from './tunnel/tunnel-server';
import type { ControlPlaneConfig } from './types';
import { PolicyEngineService, ApprovalWorkflow, AuditLog } from './policy/index';

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
  private server?: http.Server | undefined;
  private actualPort = 0;

  constructor(options: Partial<ControlPlaneConfig> = {}, db?: IDatabase) {
    this.config = loadConfig(options);
    this.db = db || new MemoryDatabase();
    this.registry = new ConnectionRegistry();

    this.tunnelServer = new TunnelServer(this.db, this.registry, {
      heartbeatTimeoutMs: this.config.heartbeatTimeoutMs,
    });

    this.clientServer = new ClientServer(this.registry, this.config.jwtSecret, this.db);

    // Wire real-time event forwarding from Gateway tunnel to Web Client subscribers
    this.tunnelServer.setOnEventBroadcast((storedEvent) => {
      this.clientServer.broadcastEvent(storedEvent);
    });

    // Policy Engine (Phase 5)
    this.policyService = new PolicyEngineService(this.db, this.config, this.auditLog);
    this.approvalWorkflow = new ApprovalWorkflow(this.db);
    this.auditLog = new AuditLog(this.db);

    this.router = new HttpRouter(
      this.db,
      this.registry,
      this.tunnelServer,
      this.config,
      this.policyService,
      this.approvalWorkflow,
      this.auditLog,
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
          this.tunnelServer.handleUpgrade(req, socket, head);
        } else if (
          path.startsWith('/ws/client') ||
          path.startsWith('/ws/events') ||
          path === '/client'
        ) {
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
        resolve({ url: this.getUrl(), port: this.actualPort });
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    this.tunnelServer.close();
    this.clientServer.close();

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

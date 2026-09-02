import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { DEFAULT_API_HOST, DEFAULT_API_PORT, DEFAULT_SHUTDOWN_TIMEOUT_MS } from '@freebuff/config';
import type {
  GatewayCore,
  SessionConfig,
  SessionFilter,
  ProjectRegistrationOptions,
  EventEnvelope,
} from '@freebuff/protocol';

export interface ApiServerOptions {
  // These three stay plain-optional: the constructor fills each from a default,
  // and `Required<...>` below relies on `?` alone to produce non-optional types.
  // Adding `| undefined` here would survive `Required<>` and leak `undefined`
  // into ApiServerStatus.
  host?: string;
  port?: number;
  allowRemote?: boolean;
  corsOrigins?: string[] | undefined;
}

export interface ApiServerStatus {
  running: boolean;
  host: string;
  port: number;
  url: string;
  startedAt?: Date | undefined;
  requestsServed: number;
  connections: number;
}

interface ParsedRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS';
  url: URL;
  path: string;
  segments: string[];
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  rawBody: string;
  requestId: string;
}

const JSON_RESPONSE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

export class LocalApiServer {
  private server?: http.Server | undefined;
  private gateway: GatewayCore;
  private options: Required<Omit<ApiServerOptions, 'corsOrigins'>> &
    Pick<ApiServerOptions, 'corsOrigins'>;
  private eventConnections: Map<string, http.ServerResponse> = new Map();
  private startedAt?: Date | undefined;
  private requestsServed = 0;
  private unsubscribeGlobal?: (() => void) | undefined;

  constructor(gateway: GatewayCore, options: ApiServerOptions = {}) {
    this.gateway = gateway;
    this.options = {
      host: options.host ?? DEFAULT_API_HOST,
      port: options.port ?? DEFAULT_API_PORT,
      allowRemote: options.allowRemote ?? false,
      corsOrigins: options.corsOrigins,
    };
  }

  getStatus(): ApiServerStatus {
    const running = this.server !== undefined && this.server.listening;
    return {
      running,
      host: this.options.host,
      port: this.options.port,
      url: `http://${this.options.host}:${this.options.port}`,
      startedAt: this.startedAt,
      requestsServed: this.requestsServed,
      connections: this.eventConnections.size,
    };
  }

  async start(): Promise<ApiServerStatus> {
    if (this.server) {
      return this.getStatus();
    }

    // handleRequest is async, and http.createServer ignores the promise it
    // returns. Handing it over directly means a rejection escaping the
    // handler's own catch — a failure inside the error path itself — surfaces
    // as an unhandled rejection and takes the Gateway process down. Void it
    // explicitly with a last-resort responder instead.
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      });
    });

    this.server.on('connection', (socket) => {
      if (!this.options.allowRemote) {
        const remote = socket.remoteAddress;
        if (remote && !['127.0.0.1', '::1', '::ffff:127.0.0.1', undefined].includes(remote)) {
          socket.destroy();
        }
      }
    });

    this.unsubscribeGlobal = this.gateway.subscribeToEvents({
      onEvent: (event) => this.broadcastEvent(event),
    });

    return new Promise((resolve, reject) => {
      if (!this.server) return reject(new Error('Server not created'));
      this.server.listen(this.options.port, this.options.host, () => {
        this.startedAt = new Date();
        const addr = this.server!.address() as AddressInfo;
        this.options.port = addr.port;
        resolve(this.getStatus());
      });
      this.server.once('error', reject);
    });
  }

  async stop(timeoutMs?: number): Promise<void> {
    if (!this.server) return;

    this.unsubscribeGlobal?.();
    this.unsubscribeGlobal = undefined;

    for (const [, res] of this.eventConnections) {
      try {
        res.end();
      } catch {
        // swallow
      }
    }
    this.eventConnections.clear();

    const server = this.server;
    this.server = undefined;
    this.startedAt = undefined;

    const deadline = Date.now() + (timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
    return new Promise((resolve) => {
      server.close((err) => {
        if (err && Date.now() < deadline) {
          setTimeout(() => server.closeAllConnections?.(), 100);
        }
        resolve();
      });
      const hardStop = setTimeout(
        () => {
          try {
            server.closeAllConnections?.();
          } catch {
            /* swallow */
          }
          resolve();
        },
        Math.max(0, deadline - Date.now()),
      );
      hardStop.unref?.();
    });
  }

  private broadcastEvent(event: EventEnvelope): void {
    if (this.eventConnections.size === 0) return;
    const data = `data: ${JSON.stringify(this.sanitizeForJson(event))}\n\n`;
    for (const [id, res] of Array.from(this.eventConnections.entries())) {
      try {
        res.write(data);
      } catch {
        try {
          res.end();
        } catch {
          /* swallow */
        }
        this.eventConnections.delete(id);
      }
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.requestsServed++;
    const requestId = `req_${Date.now().toString(36)}_${this.requestsServed}`;

    try {
      const parsed = await this.parseRequest(req, requestId);

      if (this.checkCors(req, res, parsed)) return;
      if (parsed.method === 'OPTIONS') {
        res.writeHead(204, this.buildCorsHeaders(req));
        res.end();
        return;
      }

      await this.route(parsed, res);
    } catch (err) {
      this.sendError(
        res,
        500,
        err instanceof Error ? err.message : 'Internal Server Error',
        requestId,
      );
    }
  }

  private checkCors(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    _parsed: ParsedRequest,
  ): boolean {
    const origin = req.headers['origin'];
    if (origin) {
      const origins = this.options.corsOrigins ?? [];
      const allowed = origins.length === 0 ? true : origins.includes(String(origin));
      if (!allowed) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'CORS policy: origin not allowed' }));
        return true;
      }
    }
    return false;
  }

  private buildCorsHeaders(req: http.IncomingMessage): Record<string, string> {
    const origin = req.headers['origin'];
    return {
      'Access-Control-Allow-Origin': origin ? String(origin) : '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Request-ID',
      'Access-Control-Expose-Headers': 'X-Request-ID,X-RateLimit-Limit,X-RateLimit-Remaining',
      'Access-Control-Max-Age': '86400',
    };
  }

  private async parseRequest(req: http.IncomingMessage, requestId: string): Promise<ParsedRequest> {
    const method = (req.method ?? 'GET').toUpperCase() as ParsedRequest['method'];
    const host = req.headers.host ?? `${this.options.host}:${this.options.port}`;
    const protocol = (req.socket as unknown as { encrypted?: boolean }).encrypted
      ? 'https'
      : 'http';
    const url = new URL(req.url ?? '/', `${protocol}://${host}`);
    const segments = url.pathname.split('/').filter(Boolean);

    const rawBody = await new Promise<string>((resolve, reject) => {
      let data = '';
      req.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8');
        if (data.length > 1024 * 1024) {
          reject(new Error('Request body too large (max 1MB)'));
          req.destroy();
        }
      });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });

    let body: unknown = undefined;
    const contentType = req.headers['content-type']?.toString().toLowerCase() ?? '';
    if (contentType.includes('application/json') && rawBody.trim()) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(',') : String(v);
    }

    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) query[k] = v;

    return {
      method,
      url,
      path: url.pathname,
      segments,
      query,
      headers,
      body,
      rawBody,
      requestId,
    };
  }

  private async route(req: ParsedRequest, res: http.ServerResponse): Promise<void> {
    const { method, segments, query, body, requestId } = req;
    const extraHeaders = {
      'X-Request-ID': requestId,
      ...this.buildCorsHeaders(req as unknown as http.IncomingMessage),
    };

    try {
      if (segments.length === 0) {
        return this.sendJson(
          res,
          200,
          {
            name: 'Freebuff Gateway API',
            version: '0.1.0',
            gatewayId: this.gateway.getGatewayId(),
            deviceId: this.gateway.getDeviceId(),
            endpoints: this.listEndpoints(),
          },
          extraHeaders,
        );
      }

      const resource = segments[0]!;

      if (resource === 'health') {
        if (method !== 'GET')
          return this.sendError(res, 405, 'Method Not Allowed', requestId, extraHeaders);
        return this.sendJson(
          res,
          200,
          {
            status: 'ok',
            timestamp: new Date().toISOString(),
            gatewayId: this.gateway.getGatewayId(),
          },
          extraHeaders,
        );
      }

      if (resource === 'status') {
        if (method !== 'GET')
          return this.sendError(res, 405, 'Method Not Allowed', requestId, extraHeaders);
        return this.sendJson(
          res,
          200,
          this.sanitizeForJson(await this.gateway.getStatus()),
          extraHeaders,
        );
      }

      if (resource === 'agents') {
        if (method === 'GET' && segments.length === 1) {
          return this.sendJson(
            res,
            200,
            this.sanitizeForJson(await this.gateway.listAgents()),
            extraHeaders,
          );
        }
        if (method === 'POST' && segments.length === 2 && segments[1] === 'detect') {
          return this.sendJson(
            res,
            200,
            this.sanitizeForJson(await this.gateway.detectAgents()),
            extraHeaders,
          );
        }
        if (method === 'GET' && segments.length === 2) {
          return this.sendJson(
            res,
            200,
            this.sanitizeForJson(await this.gateway.getAgent(segments[1]!)),
            extraHeaders,
          );
        }
      }

      if (resource === 'projects') {
        if (method === 'GET' && segments.length === 1) {
          return this.sendJson(
            res,
            200,
            this.sanitizeForJson(await this.gateway.listProjects()),
            extraHeaders,
          );
        }
        if (method === 'POST' && segments.length === 1) {
          const result = await this.gateway.registerProject(body as ProjectRegistrationOptions);
          return this.sendJson(res, 201, this.sanitizeForJson(result), extraHeaders);
        }
        if (method === 'POST' && segments.length === 2 && segments[1] === 'validate') {
          const { root } = (body as { root?: string }) ?? {};
          if (!root) return this.sendError(res, 400, '"root" is required', requestId, extraHeaders);
          return this.sendJson(
            res,
            200,
            this.sanitizeForJson(await this.gateway.validateProject(root)),
            extraHeaders,
          );
        }
        if (method === 'GET' && segments.length === 2 && segments[1] === 'stats') {
          return this.sendJson(
            res,
            200,
            this.sanitizeForJson(await this.gateway.getProjectStats()),
            extraHeaders,
          );
        }
        if (method === 'GET' && segments.length === 2) {
          return this.sendJson(
            res,
            200,
            this.sanitizeForJson(await this.gateway.getProject(segments[1]!)),
            extraHeaders,
          );
        }
        if (method === 'DELETE' && segments.length === 2) {
          await this.gateway.removeProject(segments[1]!);
          return this.sendJson(res, 204, null, extraHeaders);
        }
      }

      if (resource === 'sessions') {
        if (method === 'GET' && segments.length === 1) {
          const filter: SessionFilter = {
            projectId: query.projectId,
            adapterId: query.adapterId,
            state: query.state ? (query.state.split(',') as SessionFilter['state']) : undefined,
            limit: query.limit ? parseInt(query.limit, 10) : undefined,
            offset: query.offset ? parseInt(query.offset, 10) : undefined,
          };
          if (query.summaries === 'true') {
            return this.sendJson(
              res,
              200,
              this.sanitizeForJson(await this.gateway.listSessionSummaries(filter)),
              extraHeaders,
            );
          }
          return this.sendJson(
            res,
            200,
            this.sanitizeForJson(await this.gateway.listSessions(filter)),
            extraHeaders,
          );
        }
        if (method === 'POST' && segments.length === 1) {
          const result = await this.gateway.createSession(body as SessionConfig);
          return this.sendJson(res, 201, this.sanitizeForJson(result), {
            ...extraHeaders,
            Location: `/sessions/${result.id}`,
          });
        }
        if (method === 'GET' && segments.length === 2) {
          return this.sendJson(
            res,
            200,
            this.sanitizeForJson(await this.gateway.getSession(segments[1]!)),
            extraHeaders,
          );
        }
        if (method === 'DELETE' && segments.length === 2) {
          const { reason, force } = (body as { reason?: string; force?: boolean }) ?? {};
          await this.gateway.stopSession(segments[1]!, reason, force);
          return this.sendJson(res, 204, null, extraHeaders);
        }
        if (
          method === 'POST' &&
          segments.length === 3 &&
          segments[1] &&
          segments[2] === 'messages'
        ) {
          const { message } = (body as { message?: string }) ?? {};
          if (!message)
            return this.sendError(res, 400, '"message" is required', requestId, extraHeaders);
          await this.gateway.sendMessage(segments[1], message);
          return this.sendJson(res, 202, { accepted: true }, extraHeaders);
        }
        if (method === 'POST' && segments.length === 3 && segments[1] && segments[2] === 'input') {
          const { data } = (body as { data?: string }) ?? {};
          if (data === undefined)
            return this.sendError(res, 400, '"data" is required', requestId, extraHeaders);
          await this.gateway.sendInput(segments[1], data);
          return this.sendJson(res, 202, { accepted: true }, extraHeaders);
        }
        if (
          method === 'POST' &&
          segments.length === 3 &&
          segments[1] &&
          segments[2] === 'approvals'
        ) {
          const { approvalId, approved, reason } =
            (body as { approvalId?: string; approved?: boolean; reason?: string }) ?? {};
          if (!approvalId || approved === undefined)
            return this.sendError(
              res,
              400,
              '"approvalId" and "approved" are required',
              requestId,
              extraHeaders,
            );
          await this.gateway.submitApproval(segments[1], approvalId, approved, reason);
          return this.sendJson(res, 202, { accepted: true }, extraHeaders);
        }
        if (method === 'GET' && segments.length === 3 && segments[1] && segments[2] === 'diff') {
          const diff = await this.gateway.collectSessionDiff(segments[1]);
          return this.sendJson(res, 200, { diff }, extraHeaders);
        }
        if (
          method === 'DELETE' &&
          segments.length === 3 &&
          segments[1] &&
          segments[2] === 'cleanup'
        ) {
          await this.gateway.cleanupSession(segments[1]);
          return this.sendJson(res, 204, null, extraHeaders);
        }
        if (segments.length === 3 && segments[1] && segments[2] === 'events') {
          const accept = req.headers['accept']?.toString().toLowerCase() ?? '';
          if (accept.includes('text/event-stream')) {
            return this.handleEventStream(segments[1], res, extraHeaders);
          }
        }
      }

      if (resource === 'events' && method === 'GET') {
        const accept = req.headers['accept']?.toString().toLowerCase() ?? '';
        if (accept.includes('text/event-stream')) {
          return this.handleEventStream(undefined, res, extraHeaders);
        }
      }

      if (resource === 'shutdown' && method === 'POST') {
        const { graceful, timeout } = (body as { graceful?: boolean; timeout?: number }) ?? {};
        await this.gateway.shutdown(graceful !== false, timeout);
        await this.stop(timeout);
        return this.sendJson(res, 202, { shutdownInitiated: true }, extraHeaders);
      }

      return this.sendError(res, 404, `Not Found: ${method} ${req.path}`, requestId, extraHeaders);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.startsWith('Session not found') ||
        message.startsWith('Project not found') ||
        message.startsWith('Agent not found') ||
        message.startsWith('Unknown adapter')
      ) {
        return this.sendError(res, 404, message, requestId, extraHeaders);
      }
      if (message.startsWith('Invalid project root') || message.includes('is required')) {
        return this.sendError(res, 400, message, requestId, extraHeaders);
      }
      return this.sendError(res, 500, message, requestId, extraHeaders);
    }
  }

  private handleEventStream(
    sessionId: string | undefined,
    res: http.ServerResponse,
    extraHeaders: Record<string, string>,
  ): void {
    res.writeHead(200, {
      ...extraHeaders,
      ...JSON_RESPONSE_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      Connection: 'keep-alive',
      'Cache-Control': 'no-transform',
    });
    res.write(': ok\n\n');
    res.write(
      `event: gateway\ndata: ${JSON.stringify({ connected: true, sessionId, timestamp: new Date().toISOString() })}\n\n`,
    );

    const id = `sse_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.eventConnections.set(id, res);

    const unsub = sessionId
      ? this.gateway.subscribeToSessionEvents(sessionId, {
          onEvent: (event) => {
            try {
              res.write(
                `event: ${event.eventType}\ndata: ${JSON.stringify(this.sanitizeForJson(event))}\n\n`,
              );
            } catch {
              /* swallow */
            }
          },
          onClose: () => {
            try {
              res.end();
            } catch {
              /* swallow */
            }
            this.eventConnections.delete(id);
          },
        })
      : this.gateway.subscribeToEvents({
          onEvent: (event) => {
            try {
              res.write(
                `event: ${event.eventType}\ndata: ${JSON.stringify(this.sanitizeForJson(event))}\n\n`,
              );
            } catch {
              /* swallow */
            }
          },
        });

    res.on('close', () => {
      unsub();
      this.eventConnections.delete(id);
    });
  }

  private listEndpoints(): Array<{ method: string; path: string; description: string }> {
    return [
      { method: 'GET', path: '/', description: 'API root info' },
      { method: 'GET', path: '/health', description: 'Health check' },
      { method: 'GET', path: '/status', description: 'Gateway status' },
      { method: 'GET', path: '/agents', description: 'List agents' },
      { method: 'POST', path: '/agents/detect', description: 'Force re-detect agents' },
      { method: 'GET', path: '/agents/{id}', description: 'Get agent info' },
      { method: 'GET', path: '/projects', description: 'List projects' },
      { method: 'POST', path: '/projects', description: 'Register project' },
      { method: 'POST', path: '/projects/validate', description: 'Validate a project root' },
      { method: 'GET', path: '/projects/{id}', description: 'Get project info' },
      { method: 'DELETE', path: '/projects/{id}', description: 'Remove project' },
      { method: 'GET', path: '/projects/stats', description: 'Project stats' },
      { method: 'GET', path: '/sessions', description: 'List sessions' },
      { method: 'POST', path: '/sessions', description: 'Create session' },
      { method: 'GET', path: '/sessions/{id}', description: 'Get session' },
      { method: 'DELETE', path: '/sessions/{id}', description: 'Stop session' },
      { method: 'POST', path: '/sessions/{id}/messages', description: 'Send user message' },
      { method: 'POST', path: '/sessions/{id}/input', description: 'Send raw input' },
      { method: 'POST', path: '/sessions/{id}/approvals', description: 'Submit approval decision' },
      { method: 'GET', path: '/sessions/{id}/diff', description: 'Get session diff' },
      { method: 'DELETE', path: '/sessions/{id}/cleanup', description: 'Cleanup session' },
      {
        method: 'GET',
        path: '/sessions/{id}/events',
        description: 'SSE event stream (per session)',
      },
      { method: 'GET', path: '/events', description: 'SSE event stream (all sessions)' },
      { method: 'POST', path: '/shutdown', description: 'Initiate gateway shutdown' },
    ];
  }

  private sendJson(
    res: http.ServerResponse,
    status: number,
    data: unknown,
    extraHeaders: Record<string, string> = {},
  ): void {
    const body = data === null ? '' : JSON.stringify(this.sanitizeForJson(data));
    res.writeHead(status, {
      ...JSON_RESPONSE_HEADERS,
      ...extraHeaders,
      'Content-Length': Buffer.byteLength(body, 'utf8').toString(),
    });
    res.end(body);
  }

  private sendError(
    res: http.ServerResponse,
    status: number,
    message: string,
    requestId: string,
    extraHeaders: Record<string, string> = {},
  ): void {
    this.sendJson(
      res,
      status,
      { error: { status, message, requestId, timestamp: new Date().toISOString() } },
      extraHeaders,
    );
  }

  private sanitizeForJson(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map((v) => this.sanitizeForJson(v));
    if (typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = this.sanitizeForJson(v);
      }
      return result;
    }
    if (typeof value === 'bigint') return Number(value);
    return value;
  }
}

export function createApiServer(gateway: GatewayCore, options?: ApiServerOptions): LocalApiServer {
  return new LocalApiServer(gateway, options);
}

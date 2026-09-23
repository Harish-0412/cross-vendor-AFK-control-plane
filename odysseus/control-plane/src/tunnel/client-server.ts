import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';

import { verifyJwt } from '../auth/jwt';
import type { IDatabase } from '../db/types';
import type { StoredEvent } from '../types';

import type { ClientConnection, ConnectionRegistry } from './connection-registry';

interface InboundClientMessage {
  type?: string;
  token?: string;
  action?: string;
  sessionId?: string;
  deviceId?: string;
  fromSequence?: number;
}

type PresenceListener = (userId: string, clients: number) => void | Promise<void>;

const AUTH_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

export class ClientServer {
  private readonly wss: WebSocketServer;
  private readonly alive = new WeakMap<WebSocket, boolean>();
  private readonly heartbeatTimer: NodeJS.Timeout;
  private presenceListener: PresenceListener = () => undefined;

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly jwtSecret: string,
    private readonly db: IDatabase,
  ) {
    this.wss = new WebSocketServer({ noServer: true });
    this.setupWss();
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  setOnPresenceChange(listener: PresenceListener): void {
    this.presenceListener = listener;
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  private setupWss(): void {
    this.wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
      const clientId = `client_${randomUUID().replace(/-/g, '')}`;
      let clientConn: ClientConnection | undefined;
      let cleanedUp = false;
      this.alive.set(socket, true);

      const authTimer = setTimeout(() => {
        if (!clientConn) socket.close(4001, 'Authentication timed out');
      }, AUTH_TIMEOUT_MS);
      authTimer.unref?.();

      const authenticate = (token: string): boolean => {
        if (clientConn) return true;
        try {
          const payload = verifyJwt(token, this.jwtSecret);
          if (!payload.sub) throw new Error('token carries no subject');
          clientConn = {
            clientId,
            userId: payload.sub,
            socket,
            connectedAt: new Date(),
            subscribedSessions: new Set<string>(),
            subscribedDevices: new Set<string>(),
          };
          this.registry.registerClient(clientConn);
          clearTimeout(authTimer);
          this.send(socket, {
            type: 'connected',
            clientId,
            userId: clientConn.userId,
            timestamp: new Date().toISOString(),
          });
          this.notifyPresence(clientConn.userId);
          return true;
        } catch {
          socket.close(4001, 'Unauthorized: invalid token');
          return false;
        }
      };

      // Non-browser callers can authenticate in a header. Browsers authenticate
      // with the first WebSocket frame so bearer tokens never appear in URLs,
      // reverse-proxy access logs, browser history, or monitoring traces.
      const header = req.headers['authorization'];
      const bearer =
        typeof header === 'string' && header.startsWith('Bearer ')
          ? header.slice('Bearer '.length).trim()
          : null;
      if (bearer) authenticate(bearer);

      socket.on('pong', () => this.alive.set(socket, true));
      socket.on('message', (data: Buffer | string) => {
        void this.handleClientMessage(socket, data, () => clientConn, authenticate).catch(
          (error: unknown) => {
            console.warn('[client-server] message handling failed:', error);
          },
        );
      });

      const cleanup = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearTimeout(authTimer);
        if (clientConn && this.registry.removeClient(clientId)) {
          this.notifyPresence(clientConn.userId);
        }
      };

      socket.on('close', cleanup);
      socket.on('error', cleanup);
    });
  }

  private async handleClientMessage(
    socket: WebSocket,
    data: Buffer | string,
    getClient: () => ClientConnection | undefined,
    authenticate: (token: string) => boolean,
  ): Promise<void> {
    let msg: InboundClientMessage;
    try {
      msg = JSON.parse(data.toString('utf8')) as InboundClientMessage;
    } catch {
      return;
    }

    if (!getClient()) {
      if (msg.type === 'auth' && typeof msg.token === 'string') authenticate(msg.token);
      return;
    }
    const client = getClient()!;
    this.alive.set(socket, true);

    if (msg.type === 'ping') {
      this.send(socket, { type: 'pong', timestamp: new Date().toISOString() });
      return;
    }
    if (msg.type === 'disconnect') {
      socket.close(1000, 'Client requested disconnect');
      return;
    }

    if (msg.action === 'subscribe_session' && typeof msg.sessionId === 'string') {
      const session = await this.db.sessions.findById(msg.sessionId);
      if (!session || session.userId !== client.userId) {
        this.send(socket, { type: 'subscription_error', resource: 'session', reason: 'Not found' });
        return;
      }
      client.subscribedSessions.add(msg.sessionId);
      this.send(socket, { type: 'subscribed', sessionId: msg.sessionId });

      if (typeof msg.fromSequence === 'number' && Number.isFinite(msg.fromSequence)) {
        const events = await this.db.events.listBySession(
          msg.sessionId,
          Math.max(0, Math.floor(msg.fromSequence)),
          2_000,
        );
        for (const event of events) this.deliverStoredEvent(socket, event, true);
      }
      return;
    }

    if (msg.action === 'unsubscribe_session' && typeof msg.sessionId === 'string') {
      client.subscribedSessions.delete(msg.sessionId);
      this.send(socket, { type: 'unsubscribed', sessionId: msg.sessionId });
      return;
    }

    if (msg.action === 'subscribe_device' && typeof msg.deviceId === 'string') {
      const device = await this.db.devices.findById(msg.deviceId);
      if (!device || device.userId !== client.userId) {
        this.send(socket, { type: 'subscription_error', resource: 'device', reason: 'Not found' });
        return;
      }
      client.subscribedDevices.add(msg.deviceId);
      this.send(socket, { type: 'subscribed', deviceId: msg.deviceId });
      return;
    }

    if (msg.action === 'unsubscribe_device' && typeof msg.deviceId === 'string') {
      client.subscribedDevices.delete(msg.deviceId);
      this.send(socket, { type: 'unsubscribed', deviceId: msg.deviceId });
    }
  }

  /** Push a message to every open socket belonging to one user. */
  sendToUser(userId: string, message: Record<string, unknown>): void {
    for (const client of this.registry.getClientsForUser(userId)) this.send(client.socket, message);
  }

  /** Workstation-side kill switch for mobile/browser connections. */
  disconnectUser(userId: string, reason: string): number {
    const clients = this.registry.getClientsForUser(userId);
    for (const client of clients) {
      this.send(client.socket, { type: 'disconnected', source: 'workstation', reason });
      try {
        client.socket.close(4004, reason.slice(0, 120));
      } catch {
        /* registry removal below is authoritative */
      }
      this.registry.removeClient(client.clientId);
    }
    if (clients.length > 0) this.notifyPresence(userId);
    return clients.length;
  }

  broadcastEvent(stored: StoredEvent): void {
    const bySession = this.registry.getClientsSubscribedToSession(stored.sessionId);
    const byDevice = this.registry.getClientsSubscribedToDevice(stored.deviceId);
    const seen = new Set<string>();

    for (const client of [...bySession, ...byDevice]) {
      if (seen.has(client.clientId)) continue;
      seen.add(client.clientId);
      this.deliverStoredEvent(client.socket, stored, false);
    }

    void (async () => {
      const device = await this.db.devices.findById(stored.deviceId);
      if (!device) return;
      for (const client of this.registry.getClientsForUser(device.userId)) {
        if (seen.has(client.clientId)) continue;
        seen.add(client.clientId);
        this.deliverStoredEvent(client.socket, stored, false);
      }
    })();
  }

  private deliverStoredEvent(socket: WebSocket, stored: StoredEvent, replayed: boolean): void {
    this.send(socket, {
      type: 'event',
      deviceId: stored.deviceId,
      sessionId: stored.sessionId,
      sequence: stored.sequence,
      eventType: stored.eventType,
      envelope: stored.envelope,
      timestamp: stored.storedAt.toISOString(),
      ...(replayed ? { replayed: true } : {}),
    });
  }

  private notifyPresence(userId: string): void {
    const count = this.registry.getClientsForUser(userId).length;
    Promise.resolve(this.presenceListener(userId, count)).catch((error: unknown) => {
      console.warn('[client-server] presence callback failed:', error);
    });
  }

  private checkHeartbeats(): void {
    for (const socket of this.wss.clients) {
      if (this.alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      this.alive.set(socket, false);
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }

  private send(socket: WebSocket, payload: Record<string, unknown>): void {
    if (socket.readyState === 1) socket.send(JSON.stringify(payload));
  }

  close(): void {
    clearInterval(this.heartbeatTimer);
    for (const socket of this.wss.clients) socket.terminate();
    this.wss.close();
  }
}

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';

import { verifyJwt } from '../auth/jwt';
import type { IDatabase } from '../db/types';
import type { StoredEvent } from '../types';

import type { ConnectionRegistry } from './connection-registry';

interface InboundClientMessage {
  type?: string;
  token?: string;
  action?: string;
  sessionId?: string;
  deviceId?: string;
}

export class ClientServer {
  private wss: WebSocketServer;
  private registry: ConnectionRegistry;
  private jwtSecret: string;
  private db: IDatabase;

  constructor(registry: ConnectionRegistry, jwtSecret: string, db: IDatabase) {
    this.registry = registry;
    this.jwtSecret = jwtSecret;
    this.db = db;
    this.wss = new WebSocketServer({ noServer: true });
    this.setupWss();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  private setupWss(): void {
    this.wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
      const clientId = `client_${randomUUID().replace(/-/g, '')}`;
      let userId: string | undefined;

      // Check for token in query parameter
      const host = req.headers.host || 'localhost';
      const url = new URL(req.url || '/', `http://${host}`);
      const token = url.searchParams.get('token');

      if (token) {
        try {
          const payload = verifyJwt(token, this.jwtSecret);
          userId = payload.sub;
        } catch {
          socket.close(4001, 'Unauthorized: Invalid token');
          return;
        }
      }

      const clientConn = {
        clientId,
        userId: userId || 'anonymous',
        socket,
        connectedAt: new Date(),
        subscribedSessions: new Set<string>(),
        subscribedDevices: new Set<string>(),
      };

      this.registry.registerClient(clientConn);

      // Send initial welcome
      this.send(socket, {
        type: 'connected',
        clientId,
        userId: clientConn.userId,
        timestamp: new Date().toISOString(),
      });

      socket.on('message', (data: Buffer | string) => {
        try {
          const raw = data.toString('utf8');
          const msg = JSON.parse(raw) as InboundClientMessage;

          // Client auth if not authenticated via URL
          if (msg.type === 'auth' && msg.token) {
            try {
              const payload = verifyJwt(msg.token, this.jwtSecret);
              clientConn.userId = payload.sub;
              this.send(socket, { type: 'auth_success', userId: payload.sub });
            } catch {
              this.send(socket, { type: 'auth_failure', reason: 'Invalid token' });
            }
            return;
          }

          // Subscriptions
          if (msg.action === 'subscribe_session' && typeof msg.sessionId === 'string') {
            clientConn.subscribedSessions.add(msg.sessionId);
            this.send(socket, { type: 'subscribed', sessionId: msg.sessionId });
            return;
          }

          if (msg.action === 'unsubscribe_session' && typeof msg.sessionId === 'string') {
            clientConn.subscribedSessions.delete(msg.sessionId);
            this.send(socket, { type: 'unsubscribed', sessionId: msg.sessionId });
            return;
          }

          if (msg.action === 'subscribe_device' && typeof msg.deviceId === 'string') {
            clientConn.subscribedDevices.add(msg.deviceId);
            this.send(socket, { type: 'subscribed', deviceId: msg.deviceId });
            return;
          }

          // A `subscribe_user` action previously existed here but wrote the
          // requested id into `subscribedDevices` (there is no subscribedUsers
          // set), and InboundClientMessage never declared a `userId` field —
          // it could not have worked. Per-user delivery is already correct
          // without it: `getClientsForUser` filters by the connection's own
          // `userId`, set once from the verified JWT at connect time.
        } catch {
          /* ignore malformed messages */
        }
      });

      socket.on('close', () => {
        this.registry.removeClient(clientId);
      });

      socket.on('error', () => {
        this.registry.removeClient(clientId);
      });
    });
  }

  broadcastEvent(stored: StoredEvent): void {
    // 1. Clients subscribed to the specific sessionId
    const bySession = this.registry.getClientsSubscribedToSession(stored.sessionId);

    // 2. Clients subscribed to this gateway device (e.g. device detail page)
    const byDevice = this.registry.getClientsSubscribedToDevice(stored.deviceId);

    // 3. Clients subscribed to the user who owns the device receive all
    //    events for that user's devices. We resolve the userId from the DB.
    const seen = new Set<string>();

    const deliver = (socket: WebSocket, message: string): void => {
      if (socket.readyState !== 1) return;
      try {
        socket.send(message);
      } catch {
        /* swallow */
      }
    };

    for (const client of bySession) {
      if (seen.has(client.clientId)) continue;
      seen.add(client.clientId);
      deliver(
        client.socket,
        JSON.stringify({
          type: 'event',
          sessionId: stored.sessionId,
          sequence: stored.sequence,
          eventType: stored.eventType,
          envelope: stored.envelope,
          timestamp: stored.storedAt.toISOString(),
        }),
      );
    }

    for (const client of byDevice) {
      if (seen.has(client.clientId)) continue;
      seen.add(client.clientId);
      deliver(
        client.socket,
        JSON.stringify({
          type: 'event',
          deviceId: stored.deviceId,
          sequence: stored.sequence,
          eventType: stored.eventType,
          envelope: stored.envelope,
          timestamp: stored.storedAt.toISOString(),
        }),
      );
    }

    void (async () => {
      const device = await this.db.devices.findById(stored.deviceId);
      if (!device) return;
      const byUser = this.registry.getClientsForUser(device.userId);
      for (const client of byUser) {
        if (seen.has(client.clientId)) continue;
        seen.add(client.clientId);
        deliver(
          client.socket,
          JSON.stringify({
            type: 'event',
            deviceId: stored.deviceId,
            sessionId: stored.sessionId,
            sequence: stored.sequence,
            eventType: stored.eventType,
            envelope: stored.envelope,
            timestamp: stored.storedAt.toISOString(),
          }),
        );
      }
    })();
  }

  private send(socket: WebSocket, payload: Record<string, unknown>): void {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(payload));
    }
  }

  close(): void {
    this.wss.close();
  }
}

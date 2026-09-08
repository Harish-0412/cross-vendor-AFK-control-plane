import type { WebSocket } from 'ws';

export interface GatewayConnection {
  deviceId: string;
  gatewayId: string;
  socket: WebSocket;
  connectedAt: Date;
  lastHeartbeatAt: Date;
  remoteAddress?: string | undefined;
  capabilities: string[];
}

export interface ClientConnection {
  clientId: string;
  userId: string;
  socket: WebSocket;
  connectedAt: Date;
  subscribedSessions: Set<string>;
  subscribedDevices: Set<string>;
}

export class ConnectionRegistry {
  private gatewayConnections = new Map<string, GatewayConnection>(); // deviceId -> GatewayConnection
  private clientConnections = new Map<string, ClientConnection>(); // clientId -> ClientConnection

  // --- Gateway Methods ---
  registerGateway(conn: GatewayConnection): void {
    const existing = this.gatewayConnections.get(conn.deviceId);
    if (existing && existing.socket !== conn.socket) {
      try {
        existing.socket.close(1000, 'Replaced by new connection');
      } catch {
        /* swallow */
      }
    }
    this.gatewayConnections.set(conn.deviceId, conn);
  }

  getGateway(deviceId: string): GatewayConnection | undefined {
    return this.gatewayConnections.get(deviceId);
  }

  removeGateway(deviceId: string): boolean {
    return this.gatewayConnections.delete(deviceId);
  }

  isDeviceOnline(deviceId: string): boolean {
    const conn = this.gatewayConnections.get(deviceId);
    if (!conn) return false;
    return conn.socket.readyState === 1; // WebSocket.OPEN
  }

  listConnectedDevices(): string[] {
    return Array.from(this.gatewayConnections.keys());
  }

  // --- Web Client Methods ---
  registerClient(conn: ClientConnection): void {
    this.clientConnections.set(conn.clientId, conn);
  }

  getClient(clientId: string): ClientConnection | undefined {
    return this.clientConnections.get(clientId);
  }

  removeClient(clientId: string): boolean {
    return this.clientConnections.delete(clientId);
  }

  subscribeClientToSession(clientId: string, sessionId: string): void {
    const conn = this.clientConnections.get(clientId);
    if (conn) conn.subscribedSessions.add(sessionId);
  }

  unsubscribeClientFromSession(clientId: string, sessionId: string): void {
    const conn = this.clientConnections.get(clientId);
    if (conn) conn.subscribedSessions.delete(sessionId);
  }

  getClientsSubscribedToSession(sessionId: string): ClientConnection[] {
    const matches: ClientConnection[] = [];
    for (const client of this.clientConnections.values()) {
      if (client.subscribedSessions.has(sessionId)) {
        matches.push(client);
      }
    }
    return matches;
  }

  getClientsForUser(userId: string): ClientConnection[] {
    const matches: ClientConnection[] = [];
    for (const client of this.clientConnections.values()) {
      if (client.userId === userId) {
        matches.push(client);
      }
    }
    return matches;
  }

  // --- Subscription helpers extended for device/user broadcast ---

  getClientsSubscribedToDevice(deviceId: string): ClientConnection[] {
    const matches: ClientConnection[] = [];
    for (const client of this.clientConnections.values()) {
      if (client.subscribedDevices.has(deviceId)) {
        matches.push(client);
      }
    }
    return matches;
  }

  // Alias for backward-compat: events routed to a gateway deviceId are also
  // delivered to any client subscribed to the gateway's owning user.
  // Alias kept for API symmetry; the real user-scoped broadcast uses
  // `getClientsForUser` with the userId resolved by the caller.
  getClientsSubscribedToUser(): ClientConnection[] {
    return [];
  }
}

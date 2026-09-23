import type { WebSocket } from 'ws';

/** What a connected gateway will currently accept. Reported on heartbeats. */
export type GatewayAdmissionPhase = 'running' | 'draining' | 'aborting' | 'stopped';

export interface GatewayConnection {
  deviceId: string;
  gatewayId: string;
  socket: WebSocket;
  connectedAt: Date;
  lastHeartbeatAt: Date;
  remoteAddress?: string | undefined;
  capabilities: string[];
  /** Absent means 'running' — older gateways do not report a phase. */
  admissionPhase?: GatewayAdmissionPhase;
  /**
   * Distinguishes concurrent connections from the same device. A gateway that
   * opens several tunnels (see cloudflared's four-connection model) sends this
   * so the Control Plane keeps them side by side instead of treating each new
   * one as a replacement for the last.
   */
  connectionId?: string | undefined;
  /** In-flight commands on this connection, used for least-loaded dispatch. */
  inFlight?: number;
}

export interface ClientConnection {
  clientId: string;
  userId: string;
  socket: WebSocket;
  connectedAt: Date;
  subscribedSessions: Set<string>;
  subscribedDevices: Set<string>;
}

const WS_OPEN = 1;

/**
 * Tracks live connections.
 *
 * A device may hold several tunnel connections at once. Losing one is then a
 * non-event rather than an outage for that device, which is the availability
 * property cloudflared gets from running four connections to at least two
 * data centres. The registry therefore maps a device to a *set* of
 * connections; the single-connection API is preserved on top of it so callers
 * that only need "a healthy connection" do not have to care.
 */
export class ConnectionRegistry {
  private gatewayConnections = new Map<string, Map<string, GatewayConnection>>();
  private clientConnections = new Map<string, ClientConnection>(); // clientId -> ClientConnection
  /** Round-robin cursor per device, so dispatch does not always pick the first. */
  private dispatchCursor = new Map<string, number>();

  // --- Gateway Methods ---
  registerGateway(conn: GatewayConnection): void {
    const key = conn.connectionId ?? 'default';
    const existing =
      this.gatewayConnections.get(conn.deviceId) ?? new Map<string, GatewayConnection>();

    // Same slot, different socket: the old one is genuinely stale. A gateway
    // that wants concurrent connections gives each a distinct connectionId, so
    // this only closes a true replacement.
    const previous = existing.get(key);
    if (previous && previous.socket !== conn.socket) {
      try {
        previous.socket.close(1000, 'Replaced by new connection');
      } catch {
        /* swallow */
      }
    }

    existing.set(key, { inFlight: 0, ...conn });
    this.gatewayConnections.set(conn.deviceId, existing);
  }

  /** Every live connection for a device, healthiest-first is not implied. */
  listGatewayConnections(deviceId: string): GatewayConnection[] {
    return Array.from(this.gatewayConnections.get(deviceId)?.values() ?? []);
  }

  /** Open connections only. */
  listHealthyConnections(deviceId: string): GatewayConnection[] {
    return this.listGatewayConnections(deviceId).filter(
      (conn) => conn.socket.readyState === WS_OPEN,
    );
  }

  countConnections(deviceId: string): number {
    return this.listHealthyConnections(deviceId).length;
  }

  /**
   * A connection suitable for sending a command.
   *
   * Picks the least-loaded healthy connection, breaking ties round-robin. Least
   * loaded matters because one slow command would otherwise block every other
   * command queued behind it on the same socket.
   */
  pickConnection(deviceId: string): GatewayConnection | undefined {
    const healthy = this.listHealthyConnections(deviceId);
    if (healthy.length === 0) return undefined;
    if (healthy.length === 1) return healthy[0];

    const minInFlight = Math.min(...healthy.map((conn) => conn.inFlight ?? 0));
    const leastLoaded = healthy.filter((conn) => (conn.inFlight ?? 0) === minInFlight);

    const cursor = (this.dispatchCursor.get(deviceId) ?? 0) % leastLoaded.length;
    this.dispatchCursor.set(deviceId, cursor + 1);
    return leastLoaded[cursor];
  }

  /** Backwards-compatible single-connection accessor. */
  getGateway(deviceId: string): GatewayConnection | undefined {
    return this.pickConnection(deviceId) ?? this.listGatewayConnections(deviceId)[0];
  }

  /** Remove one connection; the device stays online if others remain. */
  removeGatewayConnection(deviceId: string, connectionId = 'default'): boolean {
    const connections = this.gatewayConnections.get(deviceId);
    if (!connections) return false;
    const removed = connections.delete(connectionId);
    if (connections.size === 0) {
      this.gatewayConnections.delete(deviceId);
      this.dispatchCursor.delete(deviceId);
    }
    return removed;
  }

  /** Remove the connection that owns this socket, wherever it is. */
  removeGatewaySocket(deviceId: string, socket: WebSocket): boolean {
    const connections = this.gatewayConnections.get(deviceId);
    if (!connections) return false;
    for (const [key, conn] of connections) {
      if (conn.socket === socket) return this.removeGatewayConnection(deviceId, key);
    }
    return false;
  }

  /** Remove every connection for a device. */
  removeGateway(deviceId: string): boolean {
    this.dispatchCursor.delete(deviceId);
    return this.gatewayConnections.delete(deviceId);
  }

  /** A device is online while ANY of its connections is open. */
  isDeviceOnline(deviceId: string): boolean {
    return this.listHealthyConnections(deviceId).length > 0;
  }

  /** Record the phase a gateway reported, across all of its connections. */
  setAdmissionPhase(deviceId: string, phase: GatewayAdmissionPhase): void {
    for (const conn of this.listGatewayConnections(deviceId)) {
      conn.admissionPhase = phase;
    }
  }

  getAdmissionPhase(deviceId: string): GatewayAdmissionPhase {
    // Any connection reporting a non-running phase wins: the gateway process
    // is shared, so one connection saying "draining" is the whole truth.
    const phases = this.listGatewayConnections(deviceId).map(
      (conn) => conn.admissionPhase ?? 'running',
    );
    return phases.find((phase) => phase !== 'running') ?? 'running';
  }

  /**
   * Online AND willing to take new work.
   *
   * A draining gateway is still online — it is finishing sessions and its
   * events still matter — but routing new work to it only produces a refusal.
   * Routing and session creation must use this, not isDeviceOnline().
   */
  isDeviceAcceptingSessions(deviceId: string): boolean {
    return this.isDeviceOnline(deviceId) && this.getAdmissionPhase(deviceId) === 'running';
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

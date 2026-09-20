/**
 * TunnelSupervisor — runs N tunnel connections instead of one.
 *
 * A single socket makes every network blip a total outage for that device: for
 * the whole reconnect window, commands fail with "device offline" and events
 * pile up in a queue. cloudflared avoids this by opening four connections to
 * at least two data centres, so losing one is a non-event.
 *
 * This is that idea at N=2 by default — most of the availability benefit for a
 * fraction of the complexity, and it forces the two things a larger N would
 * need anyway: idempotent event storage on the Control Plane, and a
 * connection registry that maps a device to a set of sockets.
 *
 * Each connection carries a distinct `connectionId` so the Control Plane keeps
 * them side by side rather than treating each new one as a replacement.
 */
import type { TunnelClient, TunnelEvent } from '@odysseus/tunnel';
import { createTunnelClient } from '@odysseus/tunnel';
import type { EventEnvelope } from '@odysseus/protocol';

import type { Logger } from './logger';
import { createNullLogger } from './logger';

export interface TunnelSupervisorOptions {
  /** How many concurrent connections to maintain. */
  connectionCount?: number;
  controlPlaneUrl: string;
  deviceId: string;
  gatewayId: string;
  authToken?: string | undefined;
  heartbeatIntervalMs?: number | undefined;
  logger?: Logger;
  /** Builds a client for one connection slot. Injectable for tests. */
  createClient?: (config: {
    controlPlaneUrl: string;
    deviceId: string;
    gatewayId: string;
    connectionId: string;
  }) => TunnelClient;
}

export interface SupervisedConnection {
  connectionId: string;
  client: TunnelClient;
}

export const DEFAULT_CONNECTION_COUNT = 2;

export class TunnelSupervisor {
  private readonly connections: SupervisedConnection[] = [];
  private readonly log: Logger;
  private readonly options: Required<
    Pick<TunnelSupervisorOptions, 'connectionCount' | 'controlPlaneUrl' | 'deviceId' | 'gatewayId'>
  >;
  private roundRobin = 0;

  constructor(options: TunnelSupervisorOptions) {
    this.log = options.logger ?? createNullLogger();
    this.options = {
      connectionCount: options.connectionCount ?? DEFAULT_CONNECTION_COUNT,
      controlPlaneUrl: options.controlPlaneUrl,
      deviceId: options.deviceId,
      gatewayId: options.gatewayId,
    };

    const build =
      options.createClient ??
      ((config) =>
        createTunnelClient({
          controlPlaneUrl: config.controlPlaneUrl,
          deviceId: config.deviceId,
          gatewayId: config.gatewayId,
          ...(options.authToken ? { authToken: options.authToken } : {}),
          ...(options.heartbeatIntervalMs
            ? { heartbeatIntervalMs: options.heartbeatIntervalMs }
            : {}),
        }));

    for (let index = 0; index < this.options.connectionCount; index++) {
      const connectionId = `conn-${index}`;
      this.connections.push({
        connectionId,
        client: build({
          controlPlaneUrl: this.options.controlPlaneUrl,
          deviceId: this.options.deviceId,
          gatewayId: this.options.gatewayId,
          connectionId,
        }),
      });
    }
  }

  list(): SupervisedConnection[] {
    return [...this.connections];
  }

  /** Connections that are currently usable. */
  healthy(): SupervisedConnection[] {
    return this.connections.filter((entry) => entry.client.isConnected());
  }

  /** The device is online while at least one connection is up. */
  isConnected(): boolean {
    return this.healthy().length > 0;
  }

  connectedCount(): number {
    return this.healthy().length;
  }

  /**
   * Wire every connection and dial them.
   *
   * Connections are dialled independently and failures are tolerated: the
   * point of running several is that some may be down. Rejecting the whole
   * start because one failed would defeat the purpose.
   */
  async connectAll(
    wire: (connection: SupervisedConnection) => void | Promise<void>,
  ): Promise<{ connected: number; failed: number }> {
    let connected = 0;
    let failed = 0;

    await Promise.all(
      this.connections.map(async (entry) => {
        try {
          await wire(entry);
          await entry.client.connect();
          connected++;
          this.log.debug('tunnel.connection_established', { connectionId: entry.connectionId });
        } catch (err) {
          failed++;
          this.log.warn('tunnel.connection_failed', {
            connectionId: entry.connectionId,
            error: err as Error,
          });
        }
      }),
    );

    return { connected, failed };
  }

  /** Subscribe to events from every connection, tagged with its id. */
  onEvent(listener: (connectionId: string, event: TunnelEvent) => void): () => void {
    const unsubscribes = this.connections.map((entry) =>
      entry.client.onEvent((event) => listener(entry.connectionId, event)),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }

  /**
   * Send an event envelope over one healthy connection.
   *
   * Round-robin across healthy connections spreads load and means a single
   * stalled socket does not hold up the stream. Duplicate delivery after a
   * reconnect is safe because the Control Plane stores events idempotently by
   * `eventId`; ordering is recoverable per session from the envelope's
   * `sequence`, so an event does not need to be pinned to one socket.
   */
  sendEvent(envelope: EventEnvelope): boolean {
    const healthy = this.healthy();
    if (healthy.length === 0) {
      // Queue on the first client; its own backlog replays after reconnect.
      this.connections[0]?.client.send('event', { event: envelope });
      return false;
    }

    const target = healthy[this.roundRobin % healthy.length];
    this.roundRobin = (this.roundRobin + 1) % Math.max(1, healthy.length);
    target?.client.send('event', { event: envelope });
    return true;
  }

  /** Broadcast to every healthy connection (used for phase announcements). */
  broadcastHeartbeat(): void {
    for (const entry of this.healthy()) {
      try {
        entry.client.sendImmediateHeartbeat();
      } catch {
        /* one failed beat must not stop the others */
      }
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      this.connections.map(async (entry) => {
        try {
          await entry.client.shutdown();
        } catch (err) {
          this.log.warn('tunnel.shutdown_error', {
            connectionId: entry.connectionId,
            error: err as Error,
          });
        }
      }),
    );
  }
}

export function createTunnelSupervisor(options: TunnelSupervisorOptions): TunnelSupervisor {
  return new TunnelSupervisor(options);
}

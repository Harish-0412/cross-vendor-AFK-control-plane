import { randomBytes } from 'node:crypto';
import type {
  TunnelConfig,
  TunnelState,
  TunnelMessage,
  TunnelMessageType,
  TunnelStats,
  TunnelEvent,
  TunnelEventListener,
} from './types';
import { DEFAULT_TUNNEL_CONFIG } from './types';

/**
 * TunnelClient - Outbound-only connection framework from Gateway to Control Plane.
 *
 * Phase 1 stub: provides the state machine, message queuing, reconnect logic,
 * and authentication state tracking. Does not actually open connections yet.
 *
 * Phase 2 will implement the actual WebSocket connection, TLS, and
 * device certificate authentication.
 *
 * Key invariant: The Gateway NEVER opens inbound ports. All connections
 * are initiated outbound by this client.
 */
export class TunnelClient {
  private readonly config: Required<TunnelConfig> & Pick<TunnelConfig, 'authToken'>;
  private _state: TunnelState = 'idle';
  private messageQueue: TunnelMessage[] = [];
  private sequenceCounter = 0;
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private stats: {
    messagesSent: number;
    messagesReceived: number;
    bytesSent: number;
    bytesReceived: number;
    connectedAt?: Date;
    lastDisconnectedAt?: Date;
    lastSentAt?: Date;
    lastReceivedAt?: Date;
    disconnectedTimeMs: number;
  } = {
    messagesSent: 0,
    messagesReceived: 0,
    bytesSent: 0,
    bytesReceived: 0,
    disconnectedTimeMs: 0,
  };
  private listeners: Set<TunnelEventListener> = new Set();
  private shuttingDown = false;

  constructor(config: TunnelConfig) {
    this.config = {
      ...DEFAULT_TUNNEL_CONFIG,
      ...config,
    };
  }

  /**
   * Get the current tunnel state.
   */
  getState(): TunnelState {
    return this._state;
  }

  /**
   * Get tunnel statistics.
   */
  getStats(): TunnelStats {
    const now = Date.now();
    let uptimeMs = 0;
    if (this.stats.connectedAt && this._state === 'connected') {
      uptimeMs = now - this.stats.connectedAt.getTime();
    }

    return {
      state: this._state,
      messagesSent: this.stats.messagesSent,
      messagesReceived: this.stats.messagesReceived,
      messagesQueued: this.messageQueue.length,
      reconnectAttempts: this.reconnectAttempts,
      bytesSent: this.stats.bytesSent,
      bytesReceived: this.stats.bytesReceived,
      connectedAt: this.stats.connectedAt,
      lastDisconnectedAt: this.stats.lastDisconnectedAt,
      lastSentAt: this.stats.lastSentAt,
      lastReceivedAt: this.stats.lastReceivedAt,
      uptimeMs,
      disconnectedTimeMs: this.stats.disconnectedTimeMs,
    };
  }

  /**
   * Initiate the tunnel connection (outbound only).
   *
   * Phase 2: This will open a WebSocket to the control plane URL.
   * Phase 1: This transitions the state machine but does not connect.
   */
  async connect(): Promise<void> {
    if (this._state === 'connected' || this._state === 'connecting') {
      return;
    }

    this.setState('connecting');

    // Phase 1 stub: simulate connection setup
    // In Phase 2, this will open: new WebSocket(this.config.controlPlaneUrl)
    //
    // The connection is always outbound:
    //   Gateway → Control Plane
    // No inbound ports are ever opened.

    // Simulate successful connection
    this.setState('connected');
    this.stats.connectedAt = new Date();
    this.reconnectAttempts = 0;

    this.startHeartbeat();
  }

  /**
   * Disconnect the tunnel.
   */
  async disconnect(): Promise<void> {
    if (this._state === 'idle' || this._state === 'disconnected' || this._state === 'disconnecting') {
      return;
    }

    this.setState('disconnecting');
    this.stopHeartbeat();
    this.stopReconnect();

    // Phase 2: close the actual WebSocket
    this.stats.disconnectedTimeMs += Date.now() - (this.stats.connectedAt?.getTime() ?? Date.now());
    this.stats.lastDisconnectedAt = new Date();

    this.setState('disconnected');
  }

  /**
   * Queue a message for sending through the tunnel.
   * Messages are buffered if the tunnel is not connected.
   */
  send(type: TunnelMessageType, payload: unknown, correlationId?: string): TunnelMessage {
    const message: TunnelMessage = {
      id: this.generateMessageId(),
      type,
      sequence: this.nextSequence(),
      timestamp: new Date(),
      payload,
      correlationId,
    };

    if (this._state === 'connected') {
      // Phase 2: actually send via WebSocket
      // For now, just record it
      this.stats.messagesSent++;
      this.stats.bytesSent += JSON.stringify(message).length;
      this.stats.lastSentAt = new Date();
    } else {
      // Queue for later delivery
      if (this.messageQueue.length >= this.config.maxQueueSize) {
        // Drop oldest messages
        this.messageQueue.splice(0, this.messageQueue.length - this.config.maxQueueSize + 1);
      }
      this.messageQueue.push(message);
    }

    this.emitEvent({
      type: 'message_sent',
      timestamp: new Date(),
      message: `Sent ${type} message`,
    });

    return message;
  }

  /**
   * Flush the message queue (send all queued messages).
   */
  async flushQueue(): Promise<number> {
    if (this._state !== 'connected') return 0;

    const count = this.messageQueue.length;
    for (const message of this.messageQueue) {
      // Phase 2: actually send via WebSocket
      this.stats.messagesSent++;
      this.stats.bytesSent += JSON.stringify(message).length;
      this.stats.lastSentAt = new Date();
    }
    this.messageQueue = [];
    return count;
  }

  /**
   * Get the message queue contents.
   */
  getQueuedMessages(): TunnelMessage[] {
    return [...this.messageQueue];
  }

  /**
   * Clear the message queue without sending.
   */
  clearQueue(): number {
    const count = this.messageQueue.length;
    this.messageQueue = [];
    return count;
  }

  /**
   * Handle an incoming message (called by Phase 2 WebSocket handler).
   */
  handleIncoming(message: TunnelMessage): void {
    this.stats.messagesReceived++;
    this.stats.bytesReceived += JSON.stringify(message).length;
    this.stats.lastReceivedAt = new Date();

    this.emitEvent({
      type: 'message_received',
      timestamp: new Date(),
      message: `Received ${message.type} message`,
    });
  }

  /**
   * Subscribe to tunnel events.
   */
  onEvent(listener: TunnelEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Check if the tunnel is connected.
   */
  isConnected(): boolean {
    return this._state === 'connected';
  }

  /**
   * Get the configured device ID.
   */
  getDeviceId(): string {
    return this.config.deviceId;
  }

  /**
   * Get the configured gateway ID.
   */
  getGatewayId(): string {
    return this.config.gatewayId;
  }

  /**
   * Update the auth token (e.g., after token refresh).
   */
  setAuthToken(token: string): void {
    this.config.authToken = token;
  }

  /**
   * Shutdown the tunnel client, cleaning up all resources.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    this.stopHeartbeat();
    this.stopReconnect();

    if (this._state !== 'idle' && this._state !== 'disconnected') {
      await this.disconnect();
    }

    this.messageQueue = [];
    this.listeners.clear();
  }

  /**
   * Initiate reconnection with exponential backoff.
   */
  private async reconnect(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.emitEvent({
        type: 'reconnect_failed',
        timestamp: new Date(),
        message: `Max reconnect attempts (${this.config.maxReconnectAttempts}) reached`,
      });
      this.setState('error');
      return;
    }

    this.setState('reconnecting');
    this.reconnectAttempts++;

    this.emitEvent({
      type: 'reconnect_attempt',
      timestamp: new Date(),
      message: `Reconnect attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts}`,
    });

    // Exponential backoff with jitter
    const baseDelay = this.config.reconnectBaseMs * Math.pow(2, this.reconnectAttempts - 1);
    const delay = Math.min(baseDelay, this.config.reconnectMaxMs) + Math.random() * 1000;

    this.reconnectTimer = setTimeout(async () => {
      try {
        // Phase 2: attempt actual reconnection
        await this.connect();
        this.emitEvent({
          type: 'reconnect_success',
          timestamp: new Date(),
          message: `Reconnected after ${this.reconnectAttempts} attempts`,
        });
        // Flush queued messages after successful reconnect
        await this.flushQueue();
      } catch {
        this.emitEvent({
          type: 'error',
          timestamp: new Date(),
          message: `Reconnect attempt ${this.reconnectAttempts} failed`,
        });
        void this.reconnect();
      }
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private startHeartbeat(): void {
    if (this.config.heartbeatIntervalMs <= 0) return;

    this.heartbeatTimer = setInterval(() => {
      if (this._state === 'connected') {
        this.send('heartbeat', { timestamp: new Date() });
      }
    }, this.config.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private setState(state: TunnelState): void {
    const previous = this._state;
    if (previous === state) return;

    this._state = state;
    this.emitEvent({
      type: 'state_change',
      timestamp: new Date(),
      state,
      previousState: previous,
      message: `Tunnel state: ${previous} → ${state}`,
    });
  }

  private emitEvent(event: TunnelEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // swallow listener errors
      }
    }
  }

  private nextSequence(): number {
    return ++this.sequenceCounter;
  }

  private generateMessageId(): string {
    const bytes = randomBytes(12);
    return `msg_${bytes.toString('hex')}`;
  }
}

export function createTunnelClient(config: TunnelConfig): TunnelClient {
  return new TunnelClient(config);
}

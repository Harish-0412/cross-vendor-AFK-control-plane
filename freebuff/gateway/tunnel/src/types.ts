/**
 * Tunnel Client Types
 *
 * Stub framework for outbound-only connections from the Gateway to the
 * Control Plane. The gateway NEVER opens inbound ports — it initiates
 * all connections outbound.
 *
 * This is the Phase 2 foundation. In Phase 1, this provides:
 * - Connection state machine (idle → connecting → connected → reconnecting)
 * - Outbound WebSocket stub with reconnect logic
 * - Message queue for offline buffering
 * - Authentication state tracking
 *
 * Phase 2 will add:
 * - TLS + device certificate authentication
 * - Full reconnect with sequence reconciliation
 * - Event replay
 */

export type TunnelState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'disconnected'
  | 'reconnecting'
  | 'reconciling'
  | 'error';

export type TunnelMessageType =
  | 'event'           // Forward event to control plane
  | 'command'         // Receive command from control plane
  | 'heartbeat'       // Bidirectional heartbeat
  | 'ack'             // Acknowledge receipt
  | 'replay'          // Replay missed events
  | 'auth'            // Authentication handshake
  | 'error';          // Error notification

export interface TunnelMessage {
  /** Unique message ID */
  id: string;

  /** Message type */
  type: TunnelMessageType;

  /** Sequence number within the tunnel */
  sequence: number;

  /** Timestamp */
  timestamp: Date;

  /** Payload */
  payload: unknown;

  /** Correlation ID for request/response matching */
  correlationId?: string;
}

export interface TunnelConfig {
  /** Control plane WebSocket URL (e.g., wss://control.example.com/tunnel) */
  controlPlaneUrl: string;

  /** Device ID for authentication */
  deviceId: string;

  /** Gateway ID */
  gatewayId: string;

  /** Authentication token (JWT or device certificate) */
  authToken?: string;

  /** Reconnect interval base in ms */
  reconnectBaseMs?: number;

  /** Reconnect interval max in ms */
  reconnectMaxMs?: number;

  /** Maximum reconnect attempts before giving up */
  maxReconnectAttempts?: number;

  /** Heartbeat interval in ms (0 = disabled) */
  heartbeatIntervalMs?: number;

  /** Message queue size limit */
  maxQueueSize?: number;

  /** Connection timeout in ms */
  connectTimeoutMs?: number;
}

export const DEFAULT_TUNNEL_CONFIG: Required<
  Pick<
    TunnelConfig,
    | 'reconnectBaseMs'
    | 'reconnectMaxMs'
    | 'maxReconnectAttempts'
    | 'heartbeatIntervalMs'
    | 'maxQueueSize'
    | 'connectTimeoutMs'
  >
> = {
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30000,
  maxReconnectAttempts: 10,
  heartbeatIntervalMs: 15000,
  maxQueueSize: 10000,
  connectTimeoutMs: 10000,
};

export interface TunnelStats {
  /** Current state */
  state: TunnelState;

  /** Total messages sent */
  messagesSent: number;

  /** Total messages received */
  messagesReceived: number;

  /** Messages currently queued (not yet sent) */
  messagesQueued: number;

  /** Total reconnect attempts */
  reconnectAttempts: number;

  /** Total bytes sent */
  bytesSent: number;

  /** Total bytes received */
  bytesReceived: number;

  /** When the tunnel was first connected */
  connectedAt?: Date;

  /** When the tunnel was last disconnected */
  lastDisconnectedAt?: Date;

  /** When the last message was sent */
  lastSentAt?: Date;

  /** When the last message was received */
  lastReceivedAt?: Date;

  /** Connection uptime in ms */
  uptimeMs: number;

  /** Total time disconnected in ms */
  disconnectedTimeMs: number;
}

export interface TunnelEvent {
  type:
    | 'state_change'
    | 'message_sent'
    | 'message_received'
    | 'reconnect_attempt'
    | 'reconnect_success'
    | 'reconnect_failed'
    | 'error';
  timestamp: Date;
  state?: TunnelState;
  previousState?: TunnelState;
  message?: string;
  error?: Error;
}

export type TunnelEventListener = (event: TunnelEvent) => void;

import type { DeviceCertificate, EventEnvelope } from '@odysseus/protocol';

export type TunnelState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'disconnecting'
  | 'disconnected'
  | 'reconnecting'
  | 'reconciling'
  | 'degraded'
  | 'error';

export type TunnelMessageType =
  | 'event'
  | 'command'
  | 'heartbeat'
  | 'ack'
  | 'replay'
  | 'auth'
  | 'auth_challenge'
  | 'auth_success'
  | 'auth_failure'
  | 'reconciliation_request'
  | 'reconciliation_response'
  | 'replay_event'
  | 'disconnect'
  | 'error';

export interface TunnelMessage {
  id: string;
  type: TunnelMessageType;
  sequence: number;
  timestamp: Date;
  payload: unknown;
  correlationId?: string | undefined;
  signature?: string;
  certificateThumbprint?: string | undefined;
}

export interface AuthPayload {
  deviceId: string;
  gatewayId: string;
  /** Which of this device's concurrent connections this socket is. */
  connectionId?: string | undefined;
  nonce: string;
  timestamp: Date;
  publicKeyJwk: Record<string, unknown>;
  certificateThumbprint?: string | undefined;
  signature: string;
}

export interface AuthChallengePayload {
  challenge: string;
  issuedAt: Date;
  expiresAt: Date;
  serverNonce: string;
}

export interface AuthSuccessPayload {
  sessionId: string;
  assignedGlobalSequence: number;
  serverTimestamp: Date;
  capabilities: string[];
}

export interface AuthFailurePayload {
  reason: string;
  code: string;
  retryable: boolean;
  retryAfterMs?: number;
  deviceStatus?: string;
}

export interface TunnelConfig {
  controlPlaneUrl: string;
  deviceId: string;
  gatewayId: string;
  /**
   * Distinguishes this connection from others opened by the same device.
   * Without it the Control Plane treats each new connection as a replacement
   * and closes the previous one, so multi-connection mode collapses back to a
   * single tunnel.
   */
  connectionId?: string;
  authToken?: string;
  tlsOptions?: {
    caCertPem?: string;
    clientCertPem?: string;
    clientKeyPem?: string;
    rejectUnauthorized?: boolean;
    serverName?: string;
  };
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /**
   * Attempts before giving up. `-1` means unlimited, which is the right
   * default for a long-lived daemon: a bounded budget means a laptop that
   * sleeps through an outage wakes up permanently disconnected. Escalation is
   * the supervisor's job (restart intensity), not the transport's.
   */
  maxReconnectAttempts?: number;
  /**
   * How long a connection must stay up before it counts as healthy and the
   * backoff resets. Resetting on `open` alone lets a connection that dies
   * immediately after connecting spin a tight reconnect loop that still reads
   * as "connected" in metrics.
   */
  healthyConnectionMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  maxQueueSize?: number;
  connectTimeoutMs?: number;
  authTimeoutMs?: number;
  wsOptions?: {
    userAgent?: string;
    origin?: string;
    headers?: Record<string, string>;
  };
  signMessages?: boolean;
  autoReconnect?: boolean;
}

export const DEFAULT_TUNNEL_CONFIG: Required<
  Omit<TunnelConfig, 'authToken' | 'tlsOptions' | 'wsOptions' | 'controlPlaneUrl'> &
    Pick<TunnelConfig, 'controlPlaneUrl'>
> = {
  controlPlaneUrl: '',
  deviceId: '',
  gatewayId: '',
  connectionId: 'default',
  // Defaults follow the NATS client's long-lived-service guidance: a short
  // base that grows to a 20s cap, with unlimited retries.
  reconnectBaseMs: 500,
  reconnectMaxMs: 20000,
  maxReconnectAttempts: -1,
  healthyConnectionMs: 10000,
  heartbeatIntervalMs: 15000,
  heartbeatTimeoutMs: 5000,
  maxQueueSize: 10000,
  connectTimeoutMs: 10000,
  authTimeoutMs: 5000,
  signMessages: true,
  autoReconnect: true,
};

export interface TunnelStats {
  state: TunnelState;
  messagesSent: number;
  messagesReceived: number;
  messagesQueued: number;
  reconnectAttempts: number;
  bytesSent: number;
  bytesReceived: number;
  connectedAt?: Date | undefined;
  lastDisconnectedAt?: Date | undefined;
  lastSentAt?: Date | undefined;
  lastReceivedAt?: Date | undefined;
  uptimeMs: number;
  disconnectedTimeMs: number;
  lastHeartbeatSentAt?: Date | undefined;
  lastHeartbeatReceivedAt?: Date | undefined;
  missedHeartbeats: number;
  authFailures: number;
  globalSequenceAcked: number;
  globalSequenceSent: number;
}

export interface TunnelEvent {
  type:
    | 'state_change'
    | 'message_sent'
    | 'message_received'
    | 'reconnect_attempt'
    | 'reconnect_success'
    | 'reconnect_failed'
    | 'auth_started'
    | 'auth_success'
    | 'auth_failure'
    | 'heartbeat_timeout'
    | 'reconciliation_started'
    | 'reconciliation_complete'
    | 'certificate_warning'
    | 'error';
  timestamp: Date;
  state?: TunnelState;
  previousState?: TunnelState;
  message?: string;
  error?: Error;
  payload?: unknown;
}

export type TunnelEventListener = (event: TunnelEvent) => void;

/**
 * How a disconnect should be treated.
 *
 * Treating every disconnect alike is why reconnect logic goes wrong: a revoked
 * device retried forever looks exactly like a flaky network, and the operator
 * sees a healthy-looking reconnect loop instead of "your device was revoked".
 */
export type TunnelFailureClass =
  | 'transient' // network blip — retry with backoff, unbounded
  | 'server_directed' // server asked us to reconnect — honour its retryAfter
  | 'auth_retryable' // pairing pending — retry slowly, a human must act
  | 'auth_fatal' // revoked/suspended — stop, never retry
  | 'protocol' // version or contract mismatch — stop
  | 'internal'; // a bug on our side

export interface TunnelFailure {
  class: TunnelFailureClass;
  code: string;
  reason: string;
  retryable: boolean;
  retryAfterMs?: number | undefined;
}

/** Auth failure codes the Control Plane can return, mapped to a policy. */
const AUTH_FAILURE_CLASSES: Record<string, TunnelFailureClass> = {
  DEVICE_REVOKED: 'auth_fatal',
  DEVICE_SUSPENDED: 'auth_fatal',
  DEVICE_NOT_TRUSTED: 'auth_retryable',
  PAIRING_PENDING: 'auth_retryable',
  INVALID_CREDENTIALS: 'auth_fatal',
  PROTOCOL_VERSION_MISMATCH: 'protocol',
  AUTH_TIMEOUT: 'transient',
};

/** How long to wait before re-attempting each class, when not told otherwise. */
export const FAILURE_CLASS_RETRY_MS: Record<TunnelFailureClass, number | null> = {
  transient: null, // use normal backoff
  server_directed: null, // use the server's retryAfterMs
  auth_retryable: 30_000, // a human has to approve in the UI; do not spin
  auth_fatal: null, // never
  protocol: null, // never
  internal: null, // never
};

export function classifyAuthFailure(payload: {
  code?: string;
  reason?: string;
  retryable?: boolean;
  retryAfterMs?: number;
}): TunnelFailure {
  const code = payload.code ?? 'UNKNOWN';
  // An explicit mapping wins; otherwise fall back to the server's own
  // `retryable` hint, and treat anything unrecognised as fatal rather than
  // retrying credentials we have no reason to think will start working.
  const failureClass =
    AUTH_FAILURE_CLASSES[code] ?? (payload.retryable ? 'auth_retryable' : 'auth_fatal');

  return {
    class: failureClass,
    code,
    reason: payload.reason ?? 'Authentication failed',
    retryable: failureClass === 'auth_retryable' || failureClass === 'transient',
    retryAfterMs: payload.retryAfterMs ?? FAILURE_CLASS_RETRY_MS[failureClass] ?? undefined,
  };
}

export interface CommandPayload {
  commandId: string;
  commandType: string;
  sessionId?: string;
  arguments: Record<string, unknown>;
  issuedAt: Date;
  signedBy: string;
  signature: string;
}

export interface EventForwardPayload {
  envelope: EventEnvelope;
}

export interface ReplayEventPayload {
  sequence: number;
  envelope: EventEnvelope;
}

export interface DisconnectPayload {
  reason: string;
  code: number;
  willReconnect: boolean;
  serverInitiated: boolean;
}

/**
 * What the gateway will currently accept. Carried on every heartbeat so the
 * Control Plane's router learns about a draining gateway within one beat
 * instead of discovering it via a failed command ten seconds later.
 */
export type GatewayAdmissionPhase = 'running' | 'draining' | 'aborting' | 'stopped';

export interface HeartbeatPayload {
  timestamp: Date;
  sequence: number;
  /** Absent is treated as 'running' for backwards compatibility. */
  admissionPhase?: GatewayAdmissionPhase;
  load?: {
    activeSessions: number;
    pendingApprovals: number;
    cpuPercent: number;
    memoryMb: number;
  };
}

/**
 * Supplies live telemetry for outbound heartbeats. The tunnel does not know
 * what the gateway is doing, so the gateway registers this instead of the
 * tunnel reaching back into it.
 */
export type HeartbeatContributor = () => Partial<HeartbeatPayload>;

export { type DeviceCertificate };
